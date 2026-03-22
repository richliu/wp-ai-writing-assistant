/* global wp, aiWritingData */
(function () {
    'use strict';

    const { registerPlugin }                             = wp.plugins;
    const { PluginSidebar, PluginSidebarMoreMenuItem }   = wp.editPost;
    const {
        PanelBody, Button, TextareaControl, SelectControl,
        Spinner, Notice, Flex, FlexItem, ToggleControl,
    }                                                    = wp.components;
    const { useState, useEffect, useRef, createElement: el } = wp.element;
    const { select, dispatch }                           = wp.data;
    const apiFetch                                       = wp.apiFetch;

    const TONES = [
        { label: '（不指定）',  value: '' },
        { label: '正式',       value: 'formal' },
        { label: '輕鬆口語',   value: 'casual' },
        { label: '專業',       value: 'professional' },
        { label: '友善親切',   value: 'friendly' },
        { label: '學術',       value: 'academic' },
    ];

    // ── Helpers ──────────────────────────────────────────────────────────────

    /**
     * If content length exceeds the configured limit, show a confirm dialog.
     * Returns true (proceed) or false (abort).
     */
    /** Truncate content to max_input_chars for summarize/suggest_meta (silent) */
    function truncateContent(content) {
        const limit = aiWritingData?.settings?.max_input_chars || 0;
        if (!limit || content.length <= limit) return content;
        return content.slice(0, limit);
    }

    /** For proofread: alert and return false if content exceeds max_input_chars */
    function checkProofreadLimit(content) {
        const limit = aiWritingData?.settings?.max_input_chars || 0;
        if (!limit || content.length <= limit) return true;
        const chars = content.length.toLocaleString();
        const lim   = limit.toLocaleString();
        window.alert(
            `文章字元數約 ${chars}，超過限制 ${lim} 字元。\n` +
            `建議改用逐段校稿（點選段落後使用段落工具列），或在設定中切換支援更大 Context 的模型。\n` +
            `傳送全文可能導致結果不完整，已中止。`
        );
        return false;
    }

    /** Strip HTML tags and WP block comments for readable plain text */
    function htmlToPlain(html) {
        const div = document.createElement('div');
        div.innerHTML = html;
        return (div.textContent || '').trim();
    }

    /**
     * Convert common Markdown formatting to HTML:
     *  - **bold** → <strong>bold</strong>
     *  - [text](url) → <a href="url">text</a>
     */
    function markdownToHtml(text) {
        // Bold: **text**
        let out = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        // Links: [text](url)
        out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
        return out;
    }

    // ── HTML escape helper ────────────────────────────────────────────────────

    function escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Diff helpers ──────────────────────────────────────────────────────────

    /** Split into word + whitespace tokens */
    function tokenize(text) {
        return text.match(/[^\s]+|\s+/g) || [];
    }

    /**
     * LCS word diff within a single paragraph (short text only).
     * Returns array of {type:'same'|'del'|'add', text} or null if too large.
     */
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

    /** Render word-level diff tokens as React children array */
    function renderWordDiff(oldText, newText) {
        const ops = wordDiff(oldText, newText);
        if (!ops) {
            // paragraph too long → just colour the whole thing
            return [
                el('span', { key: 'o', className: 'ai-diff-del' }, oldText),
                el('span', { key: 'n', className: 'ai-diff-add' }, newText),
            ];
        }
        return ops.map((op, idx) => {
            if (op.type === 'same') return op.text;
            if (op.type === 'del')  return el('span', { key: idx, className: 'ai-diff-del' }, op.text);
            return el('span', { key: idx, className: 'ai-diff-add' }, op.text);
        });
    }

    /**
     * Paragraph-level LCS diff.
     * Returns ops: {type:'same'|'del'|'add'|'change', old?, new?, text?}
     */
    function paragraphDiff(oldText, newText) {
        const split = t => t.split(/\n+/).map(p => p.trim()).filter(Boolean);
        const oldP = split(oldText);
        const newP = split(newText);
        const m = oldP.length, n = newP.length;

        const dp = Array.from({ length: m+1 }, () => new Int32Array(n+1));
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                dp[i][j] = oldP[i-1] === newP[j-1]
                    ? dp[i-1][j-1] + 1
                    : Math.max(dp[i-1][j], dp[i][j-1]);
            }
        }
        const raw = [];
        let i = m, j = n;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && oldP[i-1] === newP[j-1]) {
                raw.unshift({ type: 'same', text: oldP[i-1] }); i--; j--;
            } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
                raw.unshift({ type: 'add',  text: newP[j-1] }); j--;
            } else {
                raw.unshift({ type: 'del',  text: oldP[i-1] }); i--;
            }
        }

        // merge adjacent del+add → change
        const ops = [];
        for (let k = 0; k < raw.length; k++) {
            if (raw[k].type === 'del' && raw[k+1]?.type === 'add') {
                ops.push({ type: 'change', old: raw[k].text, new: raw[k+1].text });
                k++;
            } else {
                ops.push(raw[k]);
            }
        }
        return ops;
    }

    /**
     * Render word diff as HTML string (for buildDiffHtml).
     * Returns the original line HTML and the new line HTML.
     */
    function wordDiffHtml(oldText, newText) {
        const wops = wordDiff(oldText, newText);
        if (!wops) {
            return {
                oldLine: `<span style="background:#ffd7d5;color:#82071e;text-decoration:line-through;border-radius:2px;padding:0 1px;">${escHtml(oldText)}</span>`,
                newLine: `<span style="background:#ccffd8;color:#116329;border-radius:2px;padding:0 1px;">${escHtml(newText)}</span>`,
            };
        }
        let oldLine = '', newLine = '';
        for (const tok of wops) {
            if (tok.type === 'same') {
                oldLine += escHtml(tok.text);
                newLine += escHtml(tok.text);
            } else if (tok.type === 'del') {
                oldLine += `<span style="background:#ffd7d5;color:#82071e;text-decoration:line-through;border-radius:2px;padding:0 1px;">${escHtml(tok.text)}</span>`;
            } else {
                newLine += `<span style="background:#ccffd8;color:#116329;border-radius:2px;padding:0 1px;">${escHtml(tok.text)}</span>`;
            }
        }
        return { oldLine, newLine };
    }

    /**
     * Build an HTML string for the diff block inserted into the editor.
     * Only shows changed paragraphs: original line then modified line, with changed words highlighted.
     */
    function buildDiffHtml(original, result) {
        const plainOld = htmlToPlain(original);
        const plainNew = htmlToPlain(result);
        const ops      = paragraphDiff(plainOld, plainNew);

        const WRAP  = 'border:1px solid #ddd;border-radius:4px;padding:12px 16px;margin:0 auto 16px;background:#fff;font-size:14px;line-height:1.8;word-break:break-word;max-width:var(--wp--style--global--content-size,840px);box-sizing:border-box;width:100%;';
        const LABEL = 'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#757575;margin:0 0 10px;';
        const P     = 'margin:0 0 2px;padding:2px 6px;border-radius:3px;';
        const SEP   = 'border-top:1px solid #eee;margin:8px 0;';
        const DEL_S = 'background:#ffd7d5;color:#82071e;text-decoration:line-through;border-radius:2px;padding:0 1px;';
        const ADD_S = 'background:#ccffd8;color:#116329;border-radius:2px;padding:0 1px;';

        const changes = ops.filter(o => o.type !== 'same');
        if (changes.length === 0) {
            return `<div style="${WRAP}"><p style="${LABEL}">AI 修改對比</p><p style="color:#666;">✓ 無修改</p></div>`;
        }

        let html = `<div style="${WRAP}"><p style="${LABEL}">AI 修改對比（${changes.length} 處）</p>`;
        let first = true;

        for (const op of ops) {
            if (op.type === 'same') continue;

            if (!first) html += `<hr style="${SEP}">`;
            first = false;

            if (op.type === 'del') {
                html += `<p style="${P}"><span style="${DEL_S}">${escHtml(op.text)}</span></p>`;
                html += `<p style="${P}color:#999;font-style:italic;">（已刪除）</p>`;
            } else if (op.type === 'add') {
                html += `<p style="${P}color:#999;font-style:italic;">（新增）</p>`;
                html += `<p style="${P}"><span style="${ADD_S}">${escHtml(op.text)}</span></p>`;
            } else {
                // change: two lines with word-level highlights
                const { oldLine, newLine } = wordDiffHtml(op.old, op.new);
                html += `<p style="${P}background:#fff5f5;">${oldLine}</p>`;
                html += `<p style="${P}background:#f0fff4;">${newLine}</p>`;
            }
        }
        html += '</div>';
        return html;
    }

    // ── DiffView component ────────────────────────────────────────────────────

    /**
     * Render word diff ops into two arrays: oldChildren (with del highlights) and newChildren (with add highlights).
     */
    function renderWordDiffPair(oldText, newText) {
        const ops = wordDiff(oldText, newText);
        if (!ops) {
            return {
                oldChildren: [el('span', { key: 'o', className: 'ai-diff-del' }, oldText)],
                newChildren: [el('span', { key: 'n', className: 'ai-diff-add' }, newText)],
            };
        }
        const oldChildren = [], newChildren = [];
        let oi = 0, ni = 0;
        for (const op of ops) {
            if (op.type === 'same') {
                oldChildren.push(op.text);
                newChildren.push(op.text);
            } else if (op.type === 'del') {
                oldChildren.push(el('span', { key: 'od' + (oi++), className: 'ai-diff-del' }, op.text));
            } else {
                newChildren.push(el('span', { key: 'na' + (ni++), className: 'ai-diff-add' }, op.text));
            }
        }
        return { oldChildren, newChildren };
    }

    function DiffView({ original, result }) {
        const plainOld = htmlToPlain(original);
        const plainNew = htmlToPlain(result);
        const ops      = paragraphDiff(plainOld, plainNew);

        const changes = ops.filter(o => o.type !== 'same');

        if (changes.length === 0) {
            return el('div', { className: 'ai-writing-diff-unified' },
                el('div', { className: 'ai-writing-diff-stats' },
                    el('span', { style: { color: '#666' } }, '✓ 無修改'),
                ),
            );
        }

        const diffEls = [];
        let idx = 0;
        for (const op of ops) {
            if (op.type === 'same') continue;

            if (diffEls.length > 0) {
                diffEls.push(el('hr', { key: 'sep' + idx, className: 'ai-diff-separator' }));
            }

            if (op.type === 'del') {
                diffEls.push(el('p', { key: idx + 'o', className: 'ai-diff-line-old' },
                    el('span', { className: 'ai-diff-del' }, op.text)));
                diffEls.push(el('p', { key: idx + 'n', className: 'ai-diff-line-note' }, '（已刪除）'));
            } else if (op.type === 'add') {
                diffEls.push(el('p', { key: idx + 'o', className: 'ai-diff-line-note' }, '（新增）'));
                diffEls.push(el('p', { key: idx + 'n', className: 'ai-diff-line-new' },
                    el('span', { className: 'ai-diff-add' }, op.text)));
            } else {
                // change: original line then new line, with word-level highlights
                const { oldChildren, newChildren } = renderWordDiffPair(op.old, op.new);
                diffEls.push(el('p', { key: idx + 'o', className: 'ai-diff-line-old' }, oldChildren));
                diffEls.push(el('p', { key: idx + 'n', className: 'ai-diff-line-new' }, newChildren));
            }
            idx++;
        }

        return el('div', { className: 'ai-writing-diff-unified' },
            el('div', { className: 'ai-writing-diff-stats' },
                el('span', { className: 'ai-diff-stat-add' }, `${changes.length} 處修改`),
            ),
            el('div', { className: 'ai-writing-diff-box' }, diffEls),
        );
    }

    // ── Post Browser Panel ────────────────────────────────────────────────────

    function PostBrowserPanel() {
        const [categories, setCategories] = useState([]);
        const [selectedCat, setSelectedCat] = useState('');
        const [posts, setPosts]             = useState([]);
        const [isLoading, setIsLoading]     = useState(false);
        const [initialized, setInitialized] = useState(false);

        const loadData = (catId) => {
            setIsLoading(true);
            const catParam = catId ? `&categories=${catId}` : '';
            apiFetch({ path: `/wp/v2/posts?per_page=20&orderby=modified&order=desc${catParam}` })
                .then(data => { setPosts(data); setIsLoading(false); })
                .catch(() => setIsLoading(false));
        };

        const handleOpen = () => {
            if (initialized) return;
            setInitialized(true);
            apiFetch({ path: '/wp/v2/categories?per_page=100&orderby=name&order=asc' })
                .then(data => {
                    const opts = [{ label: '（全部分類）', value: '' }]
                        .concat(data.map(c => ({ label: c.name, value: String(c.id) })));
                    setCategories(opts);
                })
                .catch(() => {});
            loadData('');
        };

        const handleCatChange = (val) => {
            setSelectedCat(val);
            loadData(val);
        };

        const editUrl = (id) =>
            `${window.location.origin}/wp-admin/post.php?post=${id}&action=edit`;

        return el(PanelBody,
            { title: '文章瀏覽', initialOpen: false, onToggle: (open) => { if (open) handleOpen(); } },

            categories.length > 0 && el(SelectControl, {
                label: '篩選分類',
                value: selectedCat,
                options: categories,
                onChange: handleCatChange,
            }),

            isLoading && el('div', { style: { textAlign: 'center', padding: '8px' } }, el(Spinner)),

            !isLoading && posts.length === 0 && initialized &&
                el('p', { style: { color: '#999', fontSize: '12px' } }, '沒有找到文章'),

            el('ul', { style: { listStyle: 'none', margin: 0, padding: 0 } },
                posts.map(post =>
                    el('li', {
                        key: post.id,
                        style: { borderBottom: '1px solid #eee', padding: '6px 0' },
                    },
                        el('a', {
                            href: editUrl(post.id),
                            target: '_blank',
                            rel: 'noopener noreferrer',
                            style: { fontSize: '12px', display: 'block', color: '#0073aa', wordBreak: 'break-word' },
                        }, post.title?.rendered || `(ID: ${post.id})`),
                        el('span', { style: { fontSize: '11px', color: '#999' } },
                            new Date(post.modified).toLocaleDateString('zh-TW')),
                    )
                ),
            ),
        );
    }

    // ── Suggest Meta Panel ────────────────────────────────────────────────────

    function SuggestMetaPanel({ forceZhTW, sumPrompt }) {
        const [isLoading, setIsLoading]       = useState(false);
        const [isAddingTag, setIsAddingTag]   = useState(false);
        const [error, setError]               = useState('');
        // AI suggestion state
        const [sugTitle, setSugTitle]         = useState('');
        const [sugTagNames, setSugTagNames]   = useState([]);   // string[]
        const [sugCatNames, setSugCatNames]   = useState([]);   // string[]
        // Post tag state (mirrors editor)
        const [appliedTags, setAppliedTags]   = useState([]);   // [{id, name}]
        const [tagInput, setTagInput]         = useState('');
        // Category state
        const [allCats, setAllCats]           = useState([]);   // [{id, name}]
        const [checkedCatIds, setCheckedCatIds] = useState([]);  // number[]
        const [showAllCats, setShowAllCats]   = useState(false);
        // Popular tags
        const [popularTags, setPopularTags]   = useState([]);   // [{id, name}]
        // AI suggestion selection (before applying)
        const [selectedSugTagNames, setSelectedSugTagNames] = useState(new Set());
        const [selectedSugCatIds,   setSelectedSugCatIds]   = useState(new Set());
        const [isApplying, setIsApplying]                   = useState(false);
        // Summary state (merged panel)
        const [sumLoading, setSumLoading]   = useState(false);
        const [sumResult,  setSumResult]    = useState('');
        const [sumError,   setSumError]     = useState('');
        const [applyTitle, setApplyTitle]   = useState(true);
        // Sidebar override for max_input_chars
        const [maxInputChars, setMaxInputChars] = useState(
            (aiWritingData?.settings?.max_input_chars) || 131072
        );

        // Load current post tags, all categories, and popular tags on mount
        useEffect(() => {
            apiFetch({ path: '/wp/v2/categories?per_page=100&orderby=name&order=asc' })
                .then(data => {
                    setAllCats(data);
                    const postCatIds = select('core/editor').getEditedPostAttribute('categories') || [];
                    setCheckedCatIds(postCatIds);
                })
                .catch(() => {});

            const tagIds = select('core/editor').getEditedPostAttribute('tags') || [];
            if (tagIds.length) {
                apiFetch({ path: `/wp/v2/tags?include=${tagIds.join(',')}&per_page=100` })
                    .then(data => setAppliedTags(data.map(t => ({ id: t.id, name: t.name }))))
                    .catch(() => {});
            }

            apiFetch({ path: '/wp/v2/tags?orderby=count&order=desc&per_page=20' })
                .then(data => setPopularTags(data.map(t => ({ id: t.id, name: t.name }))))
                .catch(() => {});
        }, []);

        // Add tag by name — resolves or creates the tag, then updates the post immediately
        const addTagByName = async (name) => {
            const trimmed = name.trim();
            if (!trimmed || isAddingTag) return;
            if (appliedTags.find(t => t.name.toLowerCase() === trimmed.toLowerCase())) {
                setTagInput('');
                return;
            }
            setIsAddingTag(true);
            setError('');
            try {
                const found = await apiFetch({
                    path: `/wp/v2/tags?search=${encodeURIComponent(trimmed)}&per_page=5`,
                });
                const exact = found.find(t => t.name.toLowerCase() === trimmed.toLowerCase());
                let tag;
                if (exact) {
                    tag = { id: exact.id, name: exact.name };
                } else {
                    const created = await apiFetch({
                        path: '/wp/v2/tags', method: 'POST', data: { name: trimmed },
                    });
                    tag = { id: created.id, name: created.name };
                }
                setAppliedTags(prev => [...prev, tag]);
                const curIds = select('core/editor').getEditedPostAttribute('tags') || [];
                dispatch('core/editor').editPost({ tags: [...new Set([...curIds, tag.id])] });
                setTagInput('');
            } catch (e) {
                setError('新增標籤失敗：' + (e.message || '未知錯誤'));
            } finally {
                setIsAddingTag(false);
            }
        };

        const removeTag = (tagId) => {
            setAppliedTags(prev => prev.filter(t => t.id !== tagId));
            const curIds = select('core/editor').getEditedPostAttribute('tags') || [];
            dispatch('core/editor').editPost({ tags: curIds.filter(id => id !== tagId) });
        };

        const toggleCat = (catId) => {
            let newIds;
            if (checkedCatIds.includes(catId)) {
                newIds = checkedCatIds.filter(id => id !== catId);
            } else {
                newIds = [...checkedCatIds, catId];
            }
            setCheckedCatIds(newIds);
            dispatch('core/editor').editPost({ categories: newIds });
        };

        const handleAnalyze = async () => {
            setIsLoading(true);
            setError('');
            setSugTitle('');
            setSugTagNames([]);
            setSugCatNames([]);
            setSelectedSugTagNames(new Set());
            setSelectedSugCatIds(new Set());

            const content = select('core/editor').getEditedPostContent();
            if (!content?.trim()) {
                setError('文章內容為空。');
                setIsLoading(false);
                return;
            }
            setSumLoading(true);
            setSumResult('');
            setSumError('');
            setApplyTitle(true);
            try {
                const truncated = maxInputChars > 0 ? content.slice(0, maxInputChars) : content;
                const [metaResp, sumResp] = await Promise.all([
                    apiFetch({
                        path: '/ai-writing/v1/process',
                        method: 'POST',
                        data: {
                            content:             truncated,
                            action:              'suggest_meta',
                            force_zh_tw:         forceZhTW ? '1' : '',
                            existing_categories: allCats.map(c => c.name),
                        },
                    }),
                    apiFetch({
                        path: '/ai-writing/v1/process',
                        method: 'POST',
                        data: {
                            content:     truncated,
                            action:      'summarize',
                            prompt_id:   sumPrompt?.id || 'summarize',
                            force_zh_tw: forceZhTW ? '1' : '',
                        },
                    }),
                ]);
                const sugTags = metaResp.tags || [];
                const sugCats = metaResp.categories || [];
                setSugTitle(metaResp.title || '');
                setSugTagNames(sugTags);
                setSugCatNames(sugCats);
                // Pre-select all suggested tags
                setSelectedSugTagNames(new Set(sugTags));
                // Pre-select all suggested categories (look up IDs)
                const sugCatIdsLocal = sugCats
                    .map(name => allCats.find(c => c.name.toLowerCase() === name.toLowerCase()))
                    .filter(Boolean)
                    .map(c => c.id);
                setSelectedSugCatIds(new Set(sugCatIdsLocal));
                setSumResult(sumResp.result || '');
            } catch (err) {
                setError(err.message || 'AI 分析失敗');
            } finally {
                setIsLoading(false);
                setSumLoading(false);
            }
        };

        // Apply selected AI suggestions (tags + categories) to the post
        const applySelections = async () => {
            setIsApplying(true);
            setError('');
            try {
                // ── Title ─────────────────────────────────────────────────────
                if (applyTitle && sugTitle) {
                    dispatch('core/editor').editPost({ title: sugTitle });
                }
                // ── Tags ──────────────────────────────────────────────────────
                const toAddNames = sugTagNames.filter(n => selectedSugTagNames.has(n));
                const currentAppliedLower = appliedTags.map(t => t.name.toLowerCase());
                const toAdd = toAddNames.filter(n => !currentAppliedLower.includes(n.toLowerCase()));
                if (toAdd.length > 0) {
                    const newTags = await Promise.all(
                        toAdd.map(async (name) => {
                            const trimmed = name.trim();
                            const found = await apiFetch({
                                path: `/wp/v2/tags?search=${encodeURIComponent(trimmed)}&per_page=5`,
                            });
                            const exact = found.find(t => t.name.toLowerCase() === trimmed.toLowerCase());
                            if (exact) return { id: exact.id, name: exact.name };
                            const created = await apiFetch({
                                path: '/wp/v2/tags', method: 'POST', data: { name: trimmed },
                            });
                            return { id: created.id, name: created.name };
                        })
                    );
                    setAppliedTags(prev => {
                        const existingIds = new Set(prev.map(t => t.id));
                        return [...prev, ...newTags.filter(t => !existingIds.has(t.id))];
                    });
                    const curTagIds = select('core/editor').getEditedPostAttribute('tags') || [];
                    dispatch('core/editor').editPost({
                        tags: [...new Set([...curTagIds, ...newTags.map(t => t.id)])],
                    });
                }
                // ── Categories ────────────────────────────────────────────────
                if (selectedSugCatIds.size > 0) {
                    const newIds = [...new Set([...checkedCatIds, ...selectedSugCatIds])];
                    setCheckedCatIds(newIds);
                    dispatch('core/editor').editPost({ categories: newIds });
                }
            } catch (e) {
                setError('套用失敗：' + (e.message || ''));
            } finally {
                setIsApplying(false);
            }
        };

        // Compute AI-suggested category objects
        const sugCatObjs = sugCatNames
            .map(name => allCats.find(c => c.name.toLowerCase() === name.toLowerCase()))
            .filter(Boolean);

        // Applied tags lowercase set (for filtering popular/suggestions)
        const appliedLower = new Set(appliedTags.map(t => t.name.toLowerCase()));

        // Categories: already-checked (not in AI suggestions)
        const sugCatIdSet = new Set(sugCatObjs.map(c => c.id));
        const checkedNonSugCats = allCats.filter(
            c => checkedCatIds.includes(c.id) && !sugCatIdSet.has(c.id)
        );
        const allOtherCats = allCats.filter(c => !sugCatIdSet.has(c.id));

        const hasSuggestions = sugTitle || sugTagNames.length > 0 || sugCatObjs.length > 0;
        const canApply = (applyTitle && !!sugTitle) || selectedSugTagNames.size > 0 || selectedSugCatIds.size > 0;

        const labelSt  = { fontSize: '11px', fontWeight: '600', color: '#757575', display: 'block', marginBottom: '5px' };
        const secSt    = { marginBottom: '16px' };
        const chipBlue = { display: 'inline-flex', alignItems: 'center', gap: '3px', background: '#e6f3ff', border: '1px solid #0073aa', borderRadius: '12px', padding: '2px 8px', fontSize: '12px' };
        const chipGray = { display: 'inline-flex', alignItems: 'center', gap: '3px', background: '#f0f0f0', border: '1px solid #ccc', borderRadius: '12px', padding: '2px 8px', fontSize: '12px', cursor: 'pointer' };
        const chipSel  = { display: 'inline-flex', alignItems: 'center', gap: '3px', background: '#e6f3ff', border: '1px solid #0073aa', borderRadius: '12px', padding: '2px 8px', fontSize: '12px', cursor: 'pointer' };
        const catRowSt = { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', marginBottom: '4px', cursor: 'pointer' };

        return el(PanelBody, { title: 'AI 標籤與分類', initialOpen: true },

            el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' } },
                el('label', { style: { fontSize: '12px', color: '#555', whiteSpace: 'nowrap' } }, '最大輸入字元'),
                el('input', {
                    type: 'number', min: '0', max: '2000000', step: '1000',
                    value: maxInputChars,
                    onChange: e => setMaxInputChars(parseInt(e.target.value, 10) || 0),
                    style: { width: '90px', fontSize: '12px' },
                }),
                el('span', { style: { fontSize: '11px', color: '#999' } }, '（0 = 不限）'),
            ),
            el(Button, {
                variant: 'secondary',
                onClick: handleAnalyze,
                disabled: isLoading,
                style: { width: '100%', justifyContent: 'center', marginBottom: '12px' },
            }, isLoading ? el(Spinner) : 'AI 分析文章'),

            error && el('p', { style: { color: '#c00', fontSize: '12px', margin: '0 0 8px' } }, error),

            // ── AI suggestions block (appears after analysis) ─────────────────
            hasSuggestions && el('div', {
                style: { background: '#f8f9fa', border: '1px solid #ddd', borderRadius: '4px', padding: '10px', marginBottom: '16px' },
            },
                el('span', { style: { ...labelSt, color: '#0073aa', marginBottom: '10px' } }, 'AI 建議（點選可取消選取）'),

                // Title
                sugTitle && el('div', { style: { marginBottom: '10px' } },
                    el('span', { style: labelSt }, '建議標題'),
                    el('label', { style: { display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer' } },
                        el('input', {
                            type: 'checkbox',
                            checked: applyTitle,
                            onChange: () => setApplyTitle(v => !v),
                            style: { marginTop: '3px', flexShrink: 0 },
                        }),
                        el('span', { style: { fontSize: '13px', color: '#333', lineHeight: '1.5' } }, sugTitle),
                    ),
                ),

                // Suggested tags (toggleable chips, pre-selected)
                sugTagNames.length > 0 && el('div', { style: { marginBottom: '10px' } },
                    el('span', { style: labelSt }, '建議標籤'),
                    el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } },
                        sugTagNames.map((name, i) => {
                            const selected = selectedSugTagNames.has(name);
                            return el('button', {
                                key: i,
                                onClick: () => setSelectedSugTagNames(prev => {
                                    const next = new Set(prev);
                                    if (next.has(name)) next.delete(name); else next.add(name);
                                    return next;
                                }),
                                style: selected ? chipSel : chipGray,
                            }, selected ? '✓ ' : '', name);
                        }),
                    ),
                ),

                // Suggested categories (toggleable checkboxes, pre-checked)
                sugCatObjs.length > 0 && el('div', { style: { marginBottom: '10px' } },
                    el('span', { style: labelSt }, '建議分類'),
                    sugCatObjs.map(cat =>
                        el('label', { key: cat.id, style: catRowSt },
                            el('input', {
                                type: 'checkbox',
                                checked: selectedSugCatIds.has(cat.id),
                                onChange: () => setSelectedSugCatIds(prev => {
                                    const next = new Set(prev);
                                    if (next.has(cat.id)) next.delete(cat.id); else next.add(cat.id);
                                    return next;
                                }),
                            }),
                            cat.name,
                        )
                    ),
                ),

                // Apply button
                el(Button, {
                    variant: 'primary',
                    onClick: applySelections,
                    disabled: isApplying || !canApply,
                    style: { width: '100%', justifyContent: 'center' },
                }, isApplying ? el(Spinner) : '套用選取的建議'),
            ),

            // ── Summary result ───────────────────────────────────────────────
            sumError && el('p', { style: { color: '#c00', fontSize: '12px', margin: '0 0 8px' } }, sumError),

            sumResult && el('div', {
                style: { background: '#f0f8ff', border: '1px solid #b3d8f5', borderRadius: '4px', padding: '10px', marginBottom: '16px' },
            },
                el('span', { style: { ...labelSt, color: '#0073aa', marginBottom: '6px' } }, 'AI 摘要'),
                el('div', { style: { fontSize: '13px', color: '#333', lineHeight: '1.6', marginBottom: '10px', whiteSpace: 'pre-wrap' } }, sumResult),
                el(Flex, { wrap: true, gap: 2 },
                    el(FlexItem, null,
                        el(Button, {
                            variant: 'primary',
                            size: 'small',
                            onClick: () => {
                                const newBlock = wp.blocks.createBlock('core/paragraph', { content: sumResult });
                                dispatch('core/block-editor').insertBlock(newBlock, 0);
                                setSumResult('');
                            },
                        }, '插入到文章頂部'),
                    ),
                    el(FlexItem, null,
                        el(Button, {
                            variant: 'secondary',
                            size: 'small',
                            onClick: () => dispatch('core/editor').editPost({ excerpt: sumResult }),
                        }, '設定為文章摘要'),
                    ),
                    el(FlexItem, null,
                        el(Button, {
                            variant: 'secondary',
                            size: 'small',
                            onClick: () => navigator.clipboard?.writeText(sumResult),
                        }, '複製'),
                    ),
                    el(FlexItem, null,
                        el(Button, {
                            isDestructive: true,
                            size: 'small',
                            onClick: () => setSumResult(''),
                        }, '捨棄'),
                    ),
                ),
            ),

            // ── Tags (current) ───────────────────────────────────────────────
            el('div', { style: secSt },
                el('span', { style: labelSt }, '標籤'),

                // Applied tags as removable chips
                appliedTags.length > 0 && el('div', {
                    style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '8px' },
                },
                    appliedTags.map(tag =>
                        el('span', { key: tag.id, style: chipBlue },
                            tag.name,
                            el('button', {
                                onClick: () => removeTag(tag.id),
                                style: { background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 0 2px', fontSize: '12px', color: '#0073aa', lineHeight: 1 },
                            }, '×'),
                        )
                    ),
                ),

                // Text input to add custom tags
                el('div', { style: { display: 'flex', gap: '4px' } },
                    el('input', {
                        type: 'text',
                        value: tagInput,
                        placeholder: '輸入標籤後按 Enter',
                        onChange: e => setTagInput(e.target.value),
                        onKeyDown: e => {
                            if (e.key === 'Enter' || e.key === ',') {
                                e.preventDefault();
                                addTagByName(tagInput);
                            }
                        },
                        style: { flex: 1, fontSize: '12px' },
                        disabled: isAddingTag,
                    }),
                    el(Button, {
                        variant: 'secondary',
                        size: 'small',
                        onClick: () => addTagByName(tagInput),
                        disabled: isAddingTag || !tagInput.trim(),
                    }, isAddingTag ? el(Spinner) : '新增'),
                ),

                // Popular tags (click to add immediately)
                popularTags.filter(t => !appliedLower.has(t.name.toLowerCase())).length > 0 && el('div', { style: { marginTop: '8px' } },
                    el('span', { style: { fontSize: '11px', color: '#999', display: 'block', marginBottom: '4px' } }, '常用標籤（點選新增）'),
                    el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } },
                        popularTags
                            .filter(t => !appliedLower.has(t.name.toLowerCase()))
                            .map(t =>
                                el('button', {
                                    key: t.id,
                                    onClick: () => addTagByName(t.name),
                                    style: chipGray,
                                }, '+ ', t.name)
                            ),
                    ),
                ),
            ),

            // ── Categories (current) ─────────────────────────────────────────
            el('div', { style: secSt },
                el('span', { style: labelSt }, '分類'),

                // Currently checked categories (immediate toggle)
                checkedNonSugCats.length > 0 && el('div', { style: { marginBottom: '6px' } },
                    checkedNonSugCats.map(cat =>
                        el('label', { key: cat.id, style: catRowSt },
                            el('input', {
                                type: 'checkbox',
                                checked: true,
                                onChange: () => toggleCat(cat.id),
                            }),
                            cat.name,
                        )
                    ),
                ),

                // Toggle to show all categories
                el(Button, {
                    variant: 'link',
                    size: 'small',
                    onClick: () => setShowAllCats(v => !v),
                    style: { fontSize: '12px', padding: '0' },
                }, showAllCats ? '▲ 隱藏所有分類' : '▼ 瀏覽所有分類'),

                showAllCats && el('div', {
                    style: { maxHeight: '220px', overflowY: 'auto', border: '1px solid #eee', borderRadius: '4px', padding: '6px', marginTop: '6px' },
                },
                    allOtherCats.map(cat =>
                        el('label', { key: cat.id, style: { ...catRowSt, fontSize: '12px' } },
                            el('input', {
                                type: 'checkbox',
                                checked: checkedCatIds.includes(cat.id),
                                onChange: () => toggleCat(cat.id),
                            }),
                            cat.name,
                        )
                    ),
                ),
            ),
        );
    }

    // ── Main Sidebar ──────────────────────────────────────────────────────────

    function AIWritingSidebar() {
        const [prompts, setPrompts]   = useState(aiWritingData.prompts || []);
        const [forceZhTW, setForceZhTW] = useState(
            aiWritingData.settings?.force_traditional_chinese || false
        );

        // ── Proofread state ──────────────────────────────────────────────────
        const [proofPromptId, setProofPromptId] = useState('');
        const [tone, setTone]                   = useState('');
        const [customPrompt, setCustomPrompt]   = useState('');
        const [proofLoading, setProofLoading]   = useState(false);
        const [proofResult, setProofResult]     = useState('');
        const [proofOriginal, setProofOriginal] = useState('');
        const [proofError, setProofError]       = useState('');

        useEffect(() => {
            apiFetch({ path: '/ai-writing/v1/prompts' })
                .then(data => {
                    setPrompts(data);
                    const nonSum = data.filter(p => p.action_type !== 'summarize');
                    const def    = nonSum.find(p => p.is_default) || nonSum[0];
                    setProofPromptId((def || {}).id || '');
                })
                .catch(() => {});
        }, []);

        const proofPrompts  = prompts.filter(p => p.action_type !== 'summarize');
        const sumPrompt     = prompts.find(p => p.action_type === 'summarize');
        const proofOptions  = proofPrompts.map(p => ({ label: p.name, value: p.id }));

        const clearProof = () => { setProofResult(''); setProofOriginal(''); };

        // ── Handlers: proofread ──────────────────────────────────────────────

        const handleRunProofread = async () => {
            setProofLoading(true);
            setProofError('');
            setProofResult('');

            const content = select('core/editor').getEditedPostContent();
            if (!content?.trim()) {
                setProofError('文章內容為空。');
                setProofLoading(false);
                return;
            }
            if (!checkProofreadLimit(content)) {
                setProofLoading(false);
                return;
            }
            setProofOriginal(content);

            try {
                const resp = await apiFetch({
                    path: '/ai-writing/v1/process',
                    method: 'POST',
                    data: {
                        content,
                        action:        'proofread',
                        tone,
                        custom_prompt: customPrompt,
                        prompt_id:     proofPromptId,
                        force_zh_tw:   forceZhTW ? '1' : '',
                    },
                });
                setProofResult(resp.result || '');
            } catch (err) {
                setProofError(err.message || '呼叫 AI 時發生錯誤，請確認 API 設定。');
            } finally {
                setProofLoading(false);
            }
        };

        const handleApplyProofread = () => {
            // Convert markdown bold/links to HTML, then split into lines
            const converted = markdownToHtml(proofResult);
            const div   = document.createElement('div');
            div.innerHTML = converted;
            // Extract lines preserving inline HTML (bold, links)
            // Handle both plain newlines and <p> wrapped output
            const lines = div.innerHTML
                .replace(/<\/p>\s*<p[^>]*>/gi, '\n')  // </p><p> → newline
                .replace(/<\/?p[^>]*>/gi, '\n')         // remaining <p> or </p>
                .split(/<br\s*\/?>|\n/)
                .map(l => l.trim())
                .filter(Boolean);

            const TEXT_BLOCKS = new Set([
                'core/paragraph', 'core/heading', 'core/quote',
                'core/preformatted', 'core/verse', 'core/pullquote',
            ]);

            const currentBlocks = select('core/block-editor').getBlocks();
            let lineIdx = 0;
            const finalBlocks = [];

            for (const block of currentBlocks) {
                if (TEXT_BLOCKS.has(block.name)) {
                    if (lineIdx < lines.length) {
                        finalBlocks.push(
                            wp.blocks.createBlock('core/paragraph', { content: lines[lineIdx++] })
                        );
                    }
                } else {
                    finalBlocks.push(block);
                }
            }
            while (lineIdx < lines.length) {
                finalBlocks.push(wp.blocks.createBlock('core/paragraph', { content: lines[lineIdx++] }));
            }

            dispatch('core/block-editor').resetBlocks(
                finalBlocks.length ? finalBlocks : wp.blocks.parse(proofResult)
            );
            clearProof();
        };

        const handleInsertDiffBlock = () => {
            const plainOld = htmlToPlain(proofOriginal);
            const plainNew = htmlToPlain(proofResult);
            const ops      = paragraphDiff(plainOld, plainNew);
            const changes  = ops.filter(o => o.type !== 'same');

            const inner = [];

            if (changes.length === 0) {
                inner.push(wp.blocks.createBlock('core/paragraph', {
                    content: '<span style="color:#666;">✓ AI 校稿：無修改</span>',
                }));
            } else {
                inner.push(wp.blocks.createBlock('core/paragraph', {
                    content: `<strong style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#757575;">▍AI 修改對比（${changes.length} 處）</strong>`,
                }));

                let first = true;
                for (const op of ops) {
                    if (op.type === 'same') continue;

                    if (!first) {
                        inner.push(wp.blocks.createBlock('core/paragraph', {
                            content: '<span style="display:block;border-top:1px solid #eee;margin:4px 0;"></span>',
                        }));
                    }
                    first = false;

                    if (op.type === 'del') {
                        inner.push(wp.blocks.createBlock('core/paragraph', {
                            content: `<mark style="background:#fff5f5;"><span style="background:#ffd7d5;color:#82071e;text-decoration:line-through;border-radius:2px;padding:0 1px;">${escHtml(op.text)}</span></mark>`,
                        }));
                        inner.push(wp.blocks.createBlock('core/paragraph', {
                            content: '<em style="color:#999;font-size:12px;">（已刪除）</em>',
                        }));
                    } else if (op.type === 'add') {
                        inner.push(wp.blocks.createBlock('core/paragraph', {
                            content: '<em style="color:#999;font-size:12px;">（新增）</em>',
                        }));
                        inner.push(wp.blocks.createBlock('core/paragraph', {
                            content: `<mark style="background:#f0fff4;"><span style="background:#ccffd8;color:#116329;border-radius:2px;padding:0 1px;">${escHtml(op.text)}</span></mark>`,
                        }));
                    } else {
                        const { oldLine, newLine } = wordDiffHtml(op.old, op.new);
                        inner.push(wp.blocks.createBlock('core/paragraph', {
                            content: `<mark style="background:#fff5f5;">${oldLine}</mark>`,
                        }));
                        inner.push(wp.blocks.createBlock('core/paragraph', {
                            content: `<mark style="background:#f0fff4;">${newLine}</mark>`,
                        }));
                    }
                }
            }

            const groupBlock = wp.blocks.createBlock('core/group', {
                style: {
                    border:  { width: '1px', color: '#ddd', radius: '4px' },
                    spacing: { padding: { top: '16px', right: '16px', bottom: '16px', left: '16px' }, blockGap: '8px' },
                },
            }, inner);

            dispatch('core/block-editor').insertBlock(groupBlock, 0);
        };

        // ── Render ────────────────────────────────────────────────────────────

        return el(wp.element.Fragment, null,

            el(PluginSidebarMoreMenuItem, { target: 'ai-writing-sidebar' }, 'AI 寫作助手'),

            el(PluginSidebar, { name: 'ai-writing-sidebar', title: 'AI 寫作助手', icon: 'edit' },

                // ── AI 標籤與分類 panel（預設展開）────────────────────────────
                el(SuggestMetaPanel, { forceZhTW, sumPrompt }),

                // ── 整篇校稿 panel（放最後）─────────────────────────────────────
                el(PanelBody, { title: '整篇校稿', initialOpen: false },

                    proofOptions.length > 0 && el(SelectControl, {
                        label: 'Prompt',
                        value: proofPromptId,
                        options: proofOptions,
                        onChange: setProofPromptId,
                    }),

                    el(SelectControl, {
                        label: '語氣',
                        value: tone,
                        options: TONES,
                        onChange: setTone,
                    }),

                    el(ToggleControl, {
                        label: '強制繁體中文',
                        help: '在 Prompt 中要求 AI 使用繁體中文回覆',
                        checked: forceZhTW,
                        onChange: setForceZhTW,
                    }),

                    el(TextareaControl, {
                        label: '額外指令',
                        value: customPrompt,
                        onChange: setCustomPrompt,
                        placeholder: '輸入額外的指令（可留空）',
                        rows: 3,
                    }),

                    el(Button, {
                        variant: 'primary',
                        onClick: handleRunProofread,
                        disabled: proofLoading,
                        style: { width: '100%', justifyContent: 'center', marginTop: '4px' },
                    }, proofLoading ? el(Spinner) : '校稿整篇文章'),
                ),

                // ── 校稿 error ──────────────────────────────────────────────────
                proofError && el(Notice, {
                    status: 'error',
                    isDismissible: true,
                    onRemove: () => setProofError(''),
                    style: { margin: '0 16px 8px' },
                }, proofError),

                // ── 校稿結果 panel ───────────────────────────────────────────────
                proofResult && el(PanelBody, { title: '修改前後對比', initialOpen: true },
                    el(DiffView, { original: proofOriginal, result: proofResult }),
                    el(Flex, { style: { marginTop: '8px' }, wrap: true, gap: 2 },
                        el(FlexItem, null,
                            el(Button, { variant: 'primary', onClick: handleApplyProofread }, '套用到文章'),
                        ),
                        el(FlexItem, null,
                            el(Button, { variant: 'secondary', onClick: handleInsertDiffBlock }, '插入比對 Block'),
                        ),
                        el(FlexItem, null,
                            el(Button, { variant: 'secondary', onClick: () => navigator.clipboard?.writeText(proofResult) }, '複製'),
                        ),
                        el(FlexItem, null,
                            el(Button, { isDestructive: true, onClick: clearProof }, '捨棄'),
                        ),
                    ),
                ),
            ),
        );
    }

    registerPlugin('ai-writing-assistant', {
        render: AIWritingSidebar,
        icon: 'edit',
    });
})();
