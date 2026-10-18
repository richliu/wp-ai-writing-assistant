/* global wp, aiWritingData */
(function () {
    'use strict';

    const { addFilter }                  = wp.hooks;
    const { createHigherOrderComponent } = wp.compose;
    const { BlockControls }              = wp.blockEditor;
    const {
        ToolbarGroup, ToolbarButton, DropdownMenu, Spinner,
    }                                    = wp.components;
    const { useState, useRef, useLayoutEffect, Fragment, createElement: el } = wp.element;
    const apiFetch                       = wp.apiFetch;
    const { select, dispatch }           = wp.data;

    const SUPPORTED_BLOCKS = [ 'core/paragraph', 'core/heading', 'core/quote' ];
    // Blocks whose `content` rich text gets proofread when doing a whole section
    const TEXT_BLOCKS      = [ 'core/paragraph', 'core/heading', 'core/list-item' ];
    const SECTION_MARK_RE  = /\[\[§(\d+)\]\]/g;

    // ── Helpers ────────────────────────────────────────────────────────────────

    function markdownToHtml(text) {
        let out = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
        return out;
    }

    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    const VOID_TAGS  = /^(br|img|wbr|hr)$/i;
    const MARKER_RE  = /\[\[(\/?)(\d+)(\/?)\]\]/g;

    function stripMarkers(text) {
        return text.replace(MARKER_RE, '');
    }

    /**
     * HTML → plain text where every inline tag becomes a marker:
     *   <a href=…>x</a> → [[1]]x[[/1]],  <br> → [[2/]]
     * tags[n] keeps the exact original open/close tag (all attributes), so the
     * AI never sees or rewrites href/target/rel/class.
     */
    function htmlToMarked(html, startSeq) {
        const root = document.createElement('div');
        root.innerHTML = html;
        const tags = {};
        let seq = startSeq || 0;
        const walk = (node) => {
            let out = '';
            node.childNodes.forEach((c) => {
                if (c.nodeType === 3) { out += c.nodeValue; return; }
                if (c.nodeType !== 1) return;
                const id    = String(++seq);
                const shell = c.cloneNode(false).outerHTML;
                if (VOID_TAGS.test(c.tagName)) {
                    tags[id] = { open: shell, close: '', isVoid: true };
                    out += '[[' + id + '/]]';
                    return;
                }
                const close = '</' + c.tagName.toLowerCase() + '>';
                tags[id] = { open: shell.slice(0, shell.length - close.length), close, isVoid: false };
                out += '[[' + id + ']]' + walk(c) + '[[/' + id + ']]';
            });
            return out;
        };
        const text = walk(root);
        return { text, tags, nextSeq: seq };
    }

    /**
     * The section around a block: from the nearest heading at/above it up to
     * (not including) the next heading, among its sibling blocks. Returns the
     * text blocks inside (recursing into lists/quotes/groups) in order.
     */
    function getSectionBlocks(clientId) {
        const be    = select('core/block-editor');
        const order = be.getBlockOrder(be.getBlockRootClientId(clientId));
        const idx   = order.indexOf(clientId);
        const isHeading = (id) => be.getBlockName(id) === 'core/heading';
        let start = idx;
        while (start > 0 && !isHeading(order[start])) start--;
        let end = idx + 1;
        while (end < order.length && !isHeading(order[end])) end++;

        const out = [];
        const collect = (block) => {
            if (TEXT_BLOCKS.includes(block.name)) {
                const html = String(block.attributes.content || '');
                if (html.replace(/<[^>]*>/g, '').trim()) {
                    out.push({ clientId: block.clientId, name: block.name, html });
                }
            }
            (block.innerBlocks || []).forEach(collect);
        };
        order.slice(start, end).forEach((id) => collect(be.getBlock(id)));
        return out;
    }

    /** Split a section result on its [[§n]] markers → { n: text } or null if the structure broke */
    function splitSection(result, count) {
        const parts = {};
        const re    = new RegExp(SECTION_MARK_RE.source, 'g');
        const hits  = [];
        let m;
        while ((m = re.exec(result))) hits.push({ n: m[1], at: m.index, end: re.lastIndex });
        if (hits.length !== count) return null;
        for (let i = 0; i < hits.length; i++) {
            const n = hits[i].n;
            if (parts[n] !== undefined || +n !== i + 1) return null;
            parts[n] = result.slice(hits[i].end, i + 1 < hits.length ? hits[i + 1].at : result.length).trim();
        }
        return parts;
    }

    /**
     * AI result (with markers) → HTML. Markers the AI dropped or broke
     * (unpaired / reordered) are stripped and reported in `lost`.
     */
    function markedToHtml(text, tags) {
        const seen = {};
        let m;
        MARKER_RE.lastIndex = 0;
        while ((m = MARKER_RE.exec(text))) {
            const id = m[2];
            const s  = seen[id] || (seen[id] = { open: [], close: [], self: 0 });
            if (m[3]) s.self++;
            else if (m[1]) s.close.push(m.index);
            else s.open.push(m.index);
        }
        const ok = {};
        Object.keys(tags).forEach((id) => {
            const s = seen[id];
            if (!s) return;
            ok[id] = tags[id].isVoid
                ? s.self === 1 && !s.open.length && !s.close.length
                : s.open.length === 1 && s.close.length === 1 && !s.self && s.open[0] < s.close[0];
        });

        let html = markdownToHtml(escapeHtml(text));
        html = html.replace(MARKER_RE, (all, close, id) => {
            if (!ok[id]) return '';
            const t = tags[id];
            if (t.isVoid) return t.open;
            return close ? t.close : t.open;
        });
        const lost = Object.keys(tags).filter((id) => !ok[id]);
        return { html, lost };
    }

    function tokenize(text) {
        // CJK (incl. full-width punctuation) diffs per character; other scripts per word
        return text.match(/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]|[^\s\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]+|\s+/g) || [];
    }

    function wordDiff(oldText, newText) {
        const oldT = tokenize(oldText);
        const newT = tokenize(newText);
        const m = oldT.length, n = newT.length;
        if (m * n > 1000000) return null;

        const dp = new Int32Array((m + 1) * (n + 1));
        const W  = n + 1;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                dp[i * W + j] = oldT[i-1] === newT[j-1]
                    ? dp[(i-1)*W+(j-1)] + 1
                    : Math.max(dp[(i-1)*W+j], dp[i*W+(j-1)]);
            }
        }
        const ops = [];
        let i = m, j = n;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && oldT[i-1] === newT[j-1]) {
                ops.unshift({ type: 'same', text: oldT[i-1] }); i--; j--;
            } else if (j > 0 && (i === 0 || dp[i*W+(j-1)] >= dp[(i-1)*W+j])) {
                ops.unshift({ type: 'add',  text: newT[j-1] }); j--;
            } else {
                ops.unshift({ type: 'del',  text: oldT[i-1] }); i--;
            }
        }
        return ops;
    }

    /** Render word diff as React children array (inline styles, no external CSS needed) */
    function renderWordDiff(oldText, newText) {
        const ops = wordDiff(oldText, newText);
        const DEL = { background: '#ffd7d5', color: '#82071e', textDecoration: 'line-through', borderRadius: '2px', padding: '0 1px' };
        const ADD = { background: '#ccffd8', color: '#116329', borderRadius: '2px', padding: '0 1px' };
        if (!ops) {
            return [
                el('span', { key: 'o', style: DEL }, oldText),
                el('span', { key: 'n', style: ADD }, newText),
            ];
        }
        return ops.map((op, idx) => {
            if (op.type === 'same') return op.text;
            if (op.type === 'del')  return el('span', { key: idx, style: DEL }, op.text);
            return el('span', { key: idx, style: ADD }, op.text);
        });
    }

    // ── HOC ────────────────────────────────────────────────────────────────────

    const withAIParagraphTools = createHigherOrderComponent((BlockEdit) => {
        return function AIParagraphWrapper(props) {
            if (!SUPPORTED_BLOCKS.includes(props.name)) {
                return el(BlockEdit, props);
            }

            const [isLoading, setIsLoading] = useState(false);
            const [error, setError]         = useState('');
            // pending: null | { scope: 'block'|'section', items: [{ clientId, label, oldPlain, newPlain, html, lost }] }
            const [pending, setPending]     = useState(null);
            const panelRef                  = useRef(null);

            // The preview is a sibling of the block element, outside any
            // layout/theme width rule — so measure the block and copy its box.
            useLayoutEffect(() => {
                const panel = panelRef.current;
                if (!panel) return;
                const doc   = panel.ownerDocument;
                const view  = doc.defaultView;
                const block = doc.querySelector('[data-block="' + props.clientId + '"]');
                if (!block) return;
                const set = (k, v) => panel.style.setProperty(k, v, 'important');
                const fit = () => {
                    const b = block.getBoundingClientRect();
                    if (!b.width) return;
                    set('max-width', 'none');
                    set('width', b.width + 'px');
                    set('margin-right', '0px');
                    set('margin-left', '0px');
                    const p = panel.getBoundingClientRect();
                    set('margin-left', (b.left - p.left) + 'px');
                };
                fit();
                const ro = view.ResizeObserver ? new view.ResizeObserver(fit) : null;
                if (ro) ro.observe(block);
                view.addEventListener('resize', fit);
                return () => {
                    if (ro) ro.disconnect();
                    view.removeEventListener('resize', fit);
                };
            }, [pending, props.clientId]);

            const prompts         = aiWritingData.prompts || [];
            const defaultPromptId = (prompts.find(p => p.id === 'proofread') || prompts[0] || {}).id || 'proofread';

            const callAI = (content, action, promptId) => apiFetch({
                path: '/ai-writing/v1/process',
                method: 'POST',
                data: {
                    content,
                    action,
                    prompt_id:   promptId,
                    force_zh_tw: aiWritingData.settings?.force_traditional_chinese ? '1' : '',
                },
            }).then(resp => (resp.result || '').trim());

            const run = async (fn) => {
                setIsLoading(true);
                setError('');
                setPending(null);
                try {
                    await fn();
                } catch (err) {
                    setError(err.message || '發生錯誤');
                } finally {
                    setIsLoading(false);
                }
            };

            const toItem = (unit, marked, result) => {
                const out = markedToHtml(result, marked.tags);
                return {
                    clientId: unit.clientId,
                    label:    unit.name === 'core/heading' ? '標題' : '',
                    oldPlain: stripMarkers(marked.text).trim(),
                    newPlain: stripMarkers(result).trim(),
                    html:     out.html,
                    lost:     out.lost.length,
                };
            };

            // ── Single block ────────────────────────────────────────────────────
            const processBlock = (promptId) => run(async () => {
                const unit   = { clientId: props.clientId, name: props.name, html: String(props.attributes.content || '') };
                const marked = htmlToMarked(unit.html);
                if (!stripMarkers(marked.text).trim()) return;
                const result = await callAI(marked.text.trim(), 'paragraph', promptId);
                setPending({ scope: 'block', items: [ toItem(unit, marked, result) ] });
            });

            // ── Whole section: heading + everything up to the next heading ─────
            const processSection = (promptId) => run(async () => {
                const units = getSectionBlocks(props.clientId);
                if (!units.length) return;
                let seq = 0;
                const marked = units.map((u) => {
                    const m = htmlToMarked(u.html, seq);
                    seq = m.nextSeq;
                    return m;
                });
                const content = marked.map((m, i) => '[[§' + (i + 1) + ']] ' + m.text.trim()).join('\n\n');
                const result  = await callAI(content, 'section', promptId);
                const parts   = splitSection(result, units.length);
                if (!parts) {
                    throw new Error('AI 打亂了段落結構（段落標記遺失或合併），未套用。請重試，或改用單段校稿。');
                }
                const items = units
                    .map((u, i) => toItem(u, marked[i], parts[i + 1]))
                    .filter(it => it.newPlain !== it.oldPlain || it.lost);
                setPending({ scope: 'section', items, total: units.length });
            });

            const handleReject = () => setPending(null);

            const handleAccept = () => {
                const { updateBlockAttributes } = dispatch('core/block-editor');
                pending.items.forEach((it) => updateBlockAttributes(it.clientId, { content: it.html }));
                handleReject();
            };

            // ── Toolbar ─────────────────────────────────────────────────────────
            const controls = el(ToolbarGroup, null,
                isLoading
                    ? el(ToolbarButton, { icon: 'update-alt', label: 'AI 處理中…', disabled: true }, el(Spinner))
                    : pending
                        ? el(Fragment, null,
                            el(ToolbarButton, {
                                icon: 'yes-alt',
                                label: '採用修改',
                                onClick: handleAccept,
                            }),
                            el(ToolbarButton, {
                                icon: 'no-alt',
                                label: '捨棄修改',
                                onClick: handleReject,
                            }),
                          )
                        : el(DropdownMenu, {
                              icon: 'editor-spellcheck',
                              label: 'AI 校稿工具',
                              controls: [
                                  [ {
                                      title: '校稿整節（預設）— 標題到下一個標題',
                                      icon: 'editor-spellcheck',
                                      onClick: () => processSection(defaultPromptId),
                                  } ],
                                  prompts.map(p => ({
                                      title: '本段：' + p.name,
                                      onClick: () => processBlock(p.id),
                                  })),
                              ],
                          }),
            );

            // ── Inline diff preview ──────────────────────────────────────────────
            const lostTotal = pending ? pending.items.reduce((n, it) => n + it.lost, 0) : 0;
            const header    = pending && pending.scope === 'section'
                ? 'AI 整節校稿預覽（' + pending.total + ' 段，' + pending.items.length + ' 段有修改）— 點工具列 ✓ 採用 或 ✕ 捨棄'
                : 'AI 修改預覽 — 點工具列 ✓ 採用 或 ✕ 捨棄';
            const diffPanel = pending && el('div', {
                ref: panelRef,
                style: {
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    padding: '8px 12px',
                    marginTop: '4px',
                    background: '#fffbe6',
                    fontSize: '13px',
                    lineHeight: '1.8',
                    wordBreak: 'break-word',
                    boxSizing: 'border-box',
                },
                className: 'ai-diff-inline-preview',
            },
                el('div', {
                    style: { fontSize: '11px', fontWeight: '600', color: '#757575', marginBottom: '6px' },
                }, header),
                lostTotal > 0 && el('div', {
                    style: { fontSize: '12px', color: '#900', marginBottom: '6px' },
                }, '⚠ AI 弄丟了 ' + lostTotal + ' 個連結/格式標記，採用後那些文字會變成純文字'),
                pending.items.length === 0
                    ? el('p', { style: { margin: 0, color: '#757575' } }, 'AI 沒有修改任何內容。')
                    : pending.items.map((it, i) => el('p', {
                          key: it.clientId,
                          style: {
                              margin: 0,
                              padding: i ? '6px 0 0' : 0,
                              borderTop: i ? '1px dashed #e0d8b0' : 'none',
                              marginTop: i ? '6px' : 0,
                              fontWeight: it.label ? 600 : 'normal',
                          },
                      }, renderWordDiff(it.oldPlain, it.newPlain))),
            );

            return el(Fragment, null,
                el(BlockEdit, props),
                el(BlockControls, null, controls),
                diffPanel,
                error && el('div', {
                    className: 'ai-writing-inline-error',
                }, '⚠ ' + error),
            );
        };
    }, 'withAIParagraphTools');

    addFilter(
        'editor.BlockEdit',
        'ai-writing/paragraph-tools',
        withAIParagraphTools
    );
})();
