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

    const SUPPORTED_BLOCKS = [ 'core/paragraph', 'core/heading', 'core/quote' ];

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
    function htmlToMarked(html) {
        const root = document.createElement('div');
        root.innerHTML = html;
        const tags = {};
        let seq = 0;
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
        return { text: walk(root), tags };
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

            const [isLoading, setIsLoading]             = useState(false);
            const [error, setError]                     = useState('');
            const [pendingResult, setPendingResult]     = useState('');
            const [pendingHtml, setPendingHtml]         = useState('');
            const [lostCount, setLostCount]             = useState(0);
            const [originalContent, setOriginalContent] = useState('');
            const panelRef                              = useRef(null);

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
            }, [pendingResult, props.clientId]);

            const prompts = aiWritingData.prompts || [];

            const processBlock = async (promptId) => {
                const rawContent = String(props.attributes.content || '');
                const marked     = htmlToMarked(rawContent);
                const plainText  = stripMarkers(marked.text).trim();
                if (!plainText) return;

                setIsLoading(true);
                setError('');
                setPendingResult('');

                try {
                    const resp = await apiFetch({
                        path: '/ai-writing/v1/process',
                        method: 'POST',
                        data: {
                            content:     marked.text.trim(),
                            action:      'paragraph',
                            prompt_id:   promptId,
                            force_zh_tw: aiWritingData.settings?.force_traditional_chinese ? '1' : '',
                        },
                    });
                    const result = (resp.result || '').trim();
                    const out    = markedToHtml(result, marked.tags);
                    setOriginalContent(plainText);
                    setPendingHtml(out.html);
                    setLostCount(out.lost.length);
                    setPendingResult(stripMarkers(result));
                } catch (err) {
                    setError(err.message || '發生錯誤');
                } finally {
                    setIsLoading(false);
                }
            };

            const handleAccept = () => {
                props.setAttributes({ content: pendingHtml });
                handleReject();
            };

            const handleReject = () => {
                setPendingResult('');
                setPendingHtml('');
                setLostCount(0);
                setOriginalContent('');
            };

            // ── Toolbar ─────────────────────────────────────────────────────────
            const controls = el(ToolbarGroup, null,
                isLoading
                    ? el(ToolbarButton, { icon: 'update-alt', label: 'AI 處理中…', disabled: true }, el(Spinner))
                    : pendingResult
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
                              icon: 'admin-generic',
                              label: 'AI 段落工具',
                              controls: prompts.map(p => ({
                                  title: p.name,
                                  onClick: () => processBlock(p.id),
                              })),
                          }),
            );

            // ── Inline diff preview ──────────────────────────────────────────────
            const diffPanel = pendingResult && el('div', {
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
                }, 'AI 修改預覽 — 點工具列 ✓ 採用 或 ✕ 捨棄'),
                lostCount > 0 && el('div', {
                    style: { fontSize: '12px', color: '#900', marginBottom: '6px' },
                }, '⚠ AI 弄丟了 ' + lostCount + ' 個連結/格式標記，採用後那些文字會變成純文字'),
                el('p', { style: { margin: 0 } }, renderWordDiff(originalContent, pendingResult)),
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
