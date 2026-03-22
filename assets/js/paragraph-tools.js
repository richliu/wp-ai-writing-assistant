/* global wp, aiWritingData */
(function () {
    'use strict';

    const { addFilter }                  = wp.hooks;
    const { createHigherOrderComponent } = wp.compose;
    const { BlockControls }              = wp.blockEditor;
    const {
        ToolbarGroup, ToolbarButton, DropdownMenu, Spinner,
    }                                    = wp.components;
    const { useState, Fragment, createElement: el } = wp.element;
    const apiFetch                       = wp.apiFetch;

    const SUPPORTED_BLOCKS = [ 'core/paragraph', 'core/heading', 'core/quote' ];

    // ── Helpers ────────────────────────────────────────────────────────────────

    function markdownToHtml(text) {
        let out = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
        return out;
    }

    function tokenize(text) {
        return text.match(/[^\s]+|\s+/g) || [];
    }

    function wordDiff(oldText, newText) {
        const oldT = tokenize(oldText);
        const newT = tokenize(newText);
        const m = oldT.length, n = newT.length;
        if (m * n > 40000) return null;

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
            const [originalContent, setOriginalContent] = useState('');

            const prompts = aiWritingData.prompts || [];

            const processBlock = async (promptId) => {
                const rawContent = props.attributes.content || '';
                const tmp = document.createElement('div');
                tmp.innerHTML = rawContent;
                const plainText = (tmp.textContent || tmp.innerText || '').trim();
                if (!plainText) return;

                setIsLoading(true);
                setError('');
                setPendingResult('');

                try {
                    const resp = await apiFetch({
                        path: '/ai-writing/v1/process',
                        method: 'POST',
                        data: {
                            content:     plainText,
                            action:      'paragraph',
                            prompt_id:   promptId,
                            force_zh_tw: aiWritingData.settings?.force_traditional_chinese ? '1' : '',
                        },
                    });
                    setOriginalContent(plainText);
                    setPendingResult(resp.result || '');
                } catch (err) {
                    setError(err.message || '發生錯誤');
                } finally {
                    setIsLoading(false);
                }
            };

            const handleAccept = () => {
                props.setAttributes({ content: markdownToHtml(pendingResult) });
                setPendingResult('');
                setOriginalContent('');
            };

            const handleReject = () => {
                setPendingResult('');
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
                style: {
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    padding: '8px 12px',
                    marginTop: '4px',
                    background: '#fffbe6',
                    fontSize: '13px',
                    lineHeight: '1.8',
                    wordBreak: 'break-word',
                    maxWidth: '100%',
                    boxSizing: 'border-box',
                },
                className: 'ai-diff-inline-preview',
            },
                el('div', {
                    style: { fontSize: '11px', fontWeight: '600', color: '#757575', marginBottom: '6px' },
                }, 'AI 修改預覽 — 點工具列 ✓ 採用 或 ✕ 捨棄'),
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
