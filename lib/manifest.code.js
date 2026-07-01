/*  Manifest Code
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
*/

// ─── Library loaders ─────────────────────────────────────────────────────────

// Lean mode: core + one language module per explicit language (via esm.run
// ESM). Full mode: the whole bundle, used once any block wants auto-detect.
// Decided on first call; a later auto-detect block flips to full mode
// (harmless — the full bundle overwrites the single hljs global).

const HLJS_FULL_URL = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/highlight.min.js';
// esm.run resolves extension-less specifiers; ".js" triggers a deprecation warning.
const HLJS_CORE_URL = 'https://esm.run/highlight.js@11.11.1/lib/core';
const HLJS_LANG_BASE = 'https://esm.run/highlight.js@11.11.1/lib/languages/';

let hljsCorePromise = null;
let hljsFullPromise = null;
const langLoadPromises = new Map();
// Set once we've committed to the full bundle; never resets.
let usingFullBundle = false;

function injectScript(src) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${src}"]`);
        if (existing) {
            if (existing.dataset.loaded === 'yes') return resolve();
            existing.addEventListener('load', () => resolve());
            existing.addEventListener('error', () => reject(new Error(`load failed: ${src}`)));
            return;
        }
        const s = document.createElement('script');
        s.src = src;
        s.async = false;
        s.onload = () => { s.dataset.loaded = 'yes'; resolve(); };
        s.onerror = () => reject(new Error(`load failed: ${src}`));
        document.head.appendChild(s);
    });
}

// Detect whether window.hljs is the full bundle (~190 langs) vs lean core.
// 50 separates the two reliably.
function hljsIsFullBundle() {
    return typeof window.hljs?.listLanguages === 'function'
        && window.hljs.listLanguages().length > 50;
}

async function loadHighlightFull() {
    if (hljsFullPromise) return hljsFullPromise;
    hljsFullPromise = injectScript(HLJS_FULL_URL).then(() => {
        if (typeof hljs === 'undefined') throw new Error('hljs undefined after full load');
        return hljs;
    });
    return hljsFullPromise;
}

async function loadHighlightCore() {
    // Don't downgrade: if the full bundle is already on window.hljs, returning
    // the lean core would clobber its grammars. Hand back the full instance.
    if (hljsIsFullBundle()) return window.hljs;
    if (hljsCorePromise) return hljsCorePromise;
    hljsCorePromise = import(HLJS_CORE_URL).then(mod => {
        // esm.run's CJS→ESM shim exposes hljs as the default export; mirror
        // onto window for call sites that read `hljs` as a global.
        const hl = mod.default;
        if (!hl) throw new Error('hljs undefined after core ESM import');
        // Guard again: the full bundle's <script> may have raced our ESM fetch.
        if (hljsIsFullBundle()) return window.hljs;
        window.hljs = hl;
        return hl;
    });
    return hljsCorePromise;
}

async function registerLanguage(lang) {
    if (!lang || lang === 'auto') return;
    const resolved = LANGUAGE_ALIASES[lang] || lang;
    // Plain-text "languages" have no grammar module — never fetch one.
    if (PLAINTEXT_LANGS.has(resolved.toLowerCase())) return;
    const core = await loadHighlightCore();
    if (core.listLanguages().includes(resolved)) return;
    if (langLoadPromises.has(resolved)) return langLoadPromises.get(resolved);
    const p = import(`${HLJS_LANG_BASE}${resolved}`)
        .then(mod => { core.registerLanguage(resolved, mod.default); })
        .catch(() => {
            // Module load failed — fall back to the full bundle (auto-detect).
            usingFullBundle = true;
            langLoadPromises.delete(resolved);
        });
    langLoadPromises.set(resolved, p);
    return p;
}

// Public entry point. Returns hljs ready to highlight `requestedLang` (or to
// auto-detect in full mode).
async function loadHighlightJS(requestedLang = null) {
    if (usingFullBundle || hljsFullPromise) return loadHighlightFull();
    // Plain-text needs an hljs instance but must not escalate or fetch a module.
    if (PLAINTEXT_LANGS.has((requestedLang || '').toLowerCase())) return loadHighlightCore();
    // Per-block auto-detect → escalate.
    if (!requestedLang || requestedLang === 'auto') {
        usingFullBundle = true;
        return loadHighlightFull();
    }
    // Lean path: core + just this language.
    const core = await loadHighlightCore();
    await registerLanguage(requestedLang);
    return core;
}

let codeJarPromise = null;
async function loadCodeJar() {
    if (typeof window.CodeJar === 'function') return window.CodeJar;
    if (codeJarPromise) return codeJarPromise;
    // codejar@4.3.0 is ESM-only; import dynamically and expose on window.
    codeJarPromise = import('https://cdn.jsdelivr.net/npm/codejar@4.3.0/dist/codejar.js')
        .then(mod => {
            window.CodeJar = mod.CodeJar;
            return mod.CodeJar;
        })
        .catch(err => {
            codeJarPromise = null;
            throw err;
        });
    return codeJarPromise;
}

// Ignore code classes/elements in the utilities scanner so it doesn't fight hljs.
if (window.ManifestUtilities) {
    window.ManifestUtilities.addIgnoredClassPattern(/^hljs/);
    window.ManifestUtilities.addIgnoredClassPattern(/^language-/);
    window.ManifestUtilities.addIgnoredClassPattern(/^copy$/);
    window.ManifestUtilities.addIgnoredClassPattern(/^copied$/);
    window.ManifestUtilities.addIgnoredClassPattern(/^lines$/);
    window.ManifestUtilities.addIgnoredClassPattern(/^selected$/);
    window.ManifestUtilities.addIgnoredClassPattern(/^expand$/);
    window.ManifestUtilities.addIgnoredElementSelector('pre');
    window.ManifestUtilities.addIgnoredElementSelector('code');
}

// ─── Language resolution ─────────────────────────────────────────────────────

// Common shortenings; resolved here to short-circuit the supported-language
// check before calling hljs.
const LANGUAGE_ALIASES = {
    js: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby',
    sh: 'bash', shell: 'bash', yml: 'yaml', html: 'xml', svg: 'xml'
};

// "Render as plain text" languages — no module fetch, no auto-detect. `txt`
// in particular has no CDN module (a 404 would escalate the page to full mode).
const PLAINTEXT_LANGS = new Set(['txt', 'text', 'plain', 'plaintext', 'none', 'nohighlight']);

function resolveLanguage(hljs, langAttr) {
    if (!langAttr || langAttr === 'auto') return null;
    const lang = LANGUAGE_ALIASES[langAttr] || langAttr;
    return hljs.listLanguages().includes(lang) ? lang : null;
}

// ─── Content prep helpers ────────────────────────────────────────────────────

// Drop leading/trailing blank lines (throw off line numbering and collapse).
function trimWrappingNewlines(text) {
    return text.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
}

// Remove the smallest common leading-whitespace block from every non-empty line.
function dedent(text) {
    const lines = text.split('\n');
    let minIndent = Infinity;
    for (const line of lines) {
        if (line.trim() === '') continue;
        const indent = line.length - line.trimStart().length;
        if (indent < minIndent) minIndent = indent;
    }
    if (minIndent === Infinity || minIndent === 0) return text;
    return lines.map(l => l.length >= minIndent ? l.slice(minIndent) : l).join('\n');
}

// Convert the raw textContent / innerHTML pulled from a host element into the
// canonical source string we feed to hljs and CodeJar.
function prepSource(raw) {
    return dedent(trimWrappingNewlines(raw));
}

// Resolve an element's source, honouring `from="#id"` (reads the referenced
// element's innerHTML) before the host's own content.
//
// HTML is the special case: authors write literal markup, so the browser parses
// it into real DOM nodes — textContent would lose the tags. innerHTML serialises
// back to source and a textarea decodes entities. Non-HTML keeps textContent
// (innerHTML would wrongly re-encode any entities the author did write).
function resolveSource(el) {
    const fromRef = el.getAttribute('from');
    if (fromRef) {
        const target = document.querySelector(fromRef);
        if (target) return prepSource(target.innerHTML);
    }
    const lang = (el.getAttribute('x-code') || el.getAttribute('language') || '').toLowerCase();
    // Markdown emits <pre x-code><code>source</code></pre>. The <code> body is
    // text-only, so textContent returns the exact author source (preserving
    // valueless attributes and formatting an innerHTML round-trip would normalise).
    const childCode = el.querySelector(':scope > code');
    if (childCode) {
        return prepSource(childCode.textContent);
    }
    // Raw HTML written directly in an .html file: read innerHTML and decode
    // entities. Valueless attributes pick up the browser's `=""` normalisation
    // here — unavoidable once parsed into DOM nodes.
    if (HTML_LIKE_LANGS.has(lang)) {
        const decoder = document.createElement('textarea');
        decoder.innerHTML = el.innerHTML;
        return prepSource(decoder.value);
    }
    return prepSource(el.textContent);
}

// All map to "xml" internally; kept in one set so source-reading behaves the
// same regardless of spelling.
const HTML_LIKE_LANGS = new Set(['html', 'xml', 'svg', 'xhtml', 'rss', 'atom']);

// ─── Highlighting ────────────────────────────────────────────────────────────

// Highlight a <code> element. Returns the language hljs used (or null).
function highlightInto(codeEl, source, hljs, requestedLang) {
    // Explicit plain text: keep the code-block chrome, no token colours.
    if (PLAINTEXT_LANGS.has((requestedLang || '').toLowerCase())) {
        codeEl.textContent = source;
        codeEl.className = 'hljs language-plaintext';
        codeEl.dataset.highlighted = 'yes';
        return 'plaintext';
    }
    const lang = resolveLanguage(hljs, requestedLang);
    if (lang) {
        const result = hljs.highlight(source, { language: lang, ignoreIllegals: true });
        codeEl.innerHTML = result.value;
        codeEl.className = `hljs language-${lang}`;
        codeEl.dataset.highlighted = 'yes';
        return lang;
    }
    // Auto-detect. Skip HTML-looking content — hljs logs a noisy warning for
    // < and > in close proximity.
    codeEl.textContent = source;
    if (!/^[^<]*<\w[^>]*>[^<]*<\/\w/.test(source)) {
        try {
            hljs.highlightElement(codeEl);
            const detected = (codeEl.className.match(/language-([\w-]+)/) || [])[1] || null;
            return detected;
        } catch (e) { /* swallow; leave content as plain text */ }
    }
    return null;
}

// ─── Inline (<code x-code>, <span x-code>, etc.) ─────────────────────────────

async function setupInline(el, hljs) {
    const source = resolveSource(el);
    const requested = el.getAttribute('x-code') || el.getAttribute('language');
    highlightInto(el, source, hljs, requested);
    if (el.hasAttribute('copy')) setupInlineCopy(el);
}

function setupInlineCopy(el) {
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', 'Click to copy');
    const fire = async (ev) => {
        if (ev.type === 'keydown' && ev.key !== 'Enter' && ev.key !== ' ') return;
        if (ev.type === 'keydown') ev.preventDefault();
        try {
            await navigator.clipboard.writeText(el.textContent);
            el.classList.add('copied');
            setTimeout(() => el.classList.remove('copied'), 1500);
            // Progressive enhancement: flash a copied-icon tooltip when the
            // tooltip plugin is present and no x-tooltip is already bound.
            if (window.ManifestTooltips && typeof window.ManifestTooltips.showTransient === 'function'
                && !el.hasAttribute('x-tooltip')) {
                window.ManifestTooltips.showTransient(
                    el,
                    '<span class="code-copied-icon" aria-hidden="true"></span>',
                    1500,
                    ['top', 'end']
                );
            }
        } catch { /* clipboard rejected (browser permissions) — fail silently */ }
    };
    el.addEventListener('click', fire);
    el.addEventListener('keydown', fire);
}

// ─── Block (<pre x-code>) ────────────────────────────────────────────────────

async function setupBlock(pre, hljs) {
    // Build-once guard — re-entry would read the .lines gutter digits back as source.
    if (pre.dataset.codeBlockBuilt === 'yes') return;
    pre.dataset.codeBlockBuilt = 'yes';

    const source = resolveSource(pre);
    const requested = pre.getAttribute('x-code') || pre.getAttribute('language');

    pre.innerHTML = '';

    // ARIA: region + label when titled
    const title = pre.getAttribute('name') || pre.getAttribute('title');
    if (title && !pre.hasAttribute('aria-label')) pre.setAttribute('aria-label', title);
    if (!pre.hasAttribute('role')) pre.setAttribute('role', 'region');

    // Title bar — skipped inside a code-group (the tab strip already shows [name]).
    const inGroup = !!pre.closest('[x-code-group]');
    if (title && !inGroup) {
        const header = document.createElement('header');
        const titleEl = document.createElement('div');
        titleEl.textContent = title;
        header.appendChild(titleEl);
        pre.appendChild(header);
    }

    // Line numbers
    if (pre.hasAttribute('lines')) {
        const lines = document.createElement('div');
        lines.className = 'lines';
        lines.setAttribute('aria-hidden', 'true');
        const count = source.split('\n').length;
        for (let i = 1; i <= count; i++) {
            const span = document.createElement('span');
            span.textContent = String(i);
            lines.appendChild(span);
        }
        pre.appendChild(lines);
    }

    // Code element (the highlight target)
    const code = document.createElement('code');
    const actualLang = highlightInto(code, source, hljs, requested);
    pre.appendChild(code);

    // Copy button (floating, top-end). Suppressed inside a group — the group
    // owns a single wrapper-level copy button targeting the active panel.
    if (pre.hasAttribute('copy') && !inGroup) setupBlockCopy(pre, code);

    // Collapse
    if (pre.hasAttribute('collapse')) setupCollapse(pre, code);

    // Editor (lazy CodeJar)
    if (pre.hasAttribute('edit')) {
        const lang = actualLang || resolveLanguage(hljs, requested);
        setupEditor(pre, code, lang, hljs);
    }
}

function setupBlockCopy(pre, code) {
    const btn = document.createElement('button');
    btn.className = 'copy';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Copy code to clipboard');
    btn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(code.textContent);
            btn.classList.add('copied');
            setTimeout(() => btn.classList.remove('copied'), 1500);
        } catch { /* clipboard rejected (browser permissions) — fail silently */ }
    });
    pre.appendChild(btn);
}

function setupCollapse(pre, code) {
    const value = pre.getAttribute('collapse');
    const threshold = parseInt(value, 10);
    const collapseAt = Number.isFinite(threshold) && threshold > 0 ? threshold : 20;
    const lineCount = code.textContent.split('\n').length;
    if (lineCount <= collapseAt) return;

    // Expose the threshold to CSS for the max-height (line-height is 1.5).
    pre.style.setProperty('--collapse-lines', String(collapseAt));
    pre.setAttribute('data-collapsed', '');

    const btn = document.createElement('button');
    btn.className = 'expand';
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    const hiddenCount = lineCount - collapseAt;
    // Visual label is locale-safe ("+N" / "−"); screen readers get an explicit
    // English aria-label.
    const updateLabel = () => {
        const collapsed = pre.hasAttribute('data-collapsed');
        btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        btn.textContent = collapsed ? `+${hiddenCount}` : '−';
        btn.setAttribute('aria-label', collapsed
            ? `Show ${hiddenCount} more line${hiddenCount === 1 ? '' : 's'}`
            : 'Show less');
    };
    btn.addEventListener('click', () => {
        if (pre.hasAttribute('data-collapsed')) pre.removeAttribute('data-collapsed');
        else pre.setAttribute('data-collapsed', '');
        updateLabel();
    });
    updateLabel();
    pre.appendChild(btn);
}

async function setupEditor(pre, code, lang, hljs) {
    try {
        const CodeJar = await loadCodeJar();
        code.setAttribute('contenteditable', 'plaintext-only');
        // Older Safari lacks plaintext-only — fall back to "true".
        if (code.getAttribute('contenteditable') !== 'plaintext-only' && code.contentEditable !== 'plaintext-only') {
            code.setAttribute('contenteditable', 'true');
        }
        code.setAttribute('spellcheck', 'false');
        if (!pre.hasAttribute('aria-label')) {
            pre.setAttribute('aria-label', lang ? `${lang} editor` : 'Code editor');
        }

        const editor = CodeJar(code, (el) => {
            if (!lang) { /* no language: leave textContent as-is */ return; }
            const text = el.textContent;
            const result = hljs.highlight(text, { language: lang, ignoreIllegals: true });
            el.innerHTML = result.value;
        }, {
            tab: '  ',
            indentOn: /[{[(]\s*$|<[a-zA-Z][^<>]*(?<!\/)>$/,
            addClosing: true
        });
        // CodeJar applies pre-wrap; our blocks are no-wrap (parent scrolls).
        code.style.whiteSpace = 'pre';
        // Expose the editor instance on the host for consumers (e.g. hero editor).
        pre._codeJar = editor;
        pre.dispatchEvent(new CustomEvent('code:editor-ready', { detail: { editor } }));
    } catch { /* CodeJar load / mount failed — fail silently */ }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

// Process one host element. Routes to inline vs block based on tag.
async function processCodeElement(el) {
    if (el.dataset.codeProcessed === 'yes') return;
    // Group-owned panels are handled wholesale by setupCodeGroup — skip here.
    if (el.parentElement && el.parentElement.hasAttribute('x-code-group')) return;
    el.dataset.codeProcessed = 'yes';

    try {
        const requestedLang = el.getAttribute('x-code') || el.getAttribute('language');
        const hljs = await loadHighlightJS(requestedLang);
        const tag = el.tagName;
        const inPre = tag === 'CODE' && el.parentElement && el.parentElement.tagName === 'PRE';

        if (tag === 'PRE') {
            await setupBlock(el, hljs);
        } else if (tag === 'CODE' && !inPre) {
            await setupInline(el, hljs);
        } else if (inPre) {
            // <pre><code x-code="…"> — bubble up to the <pre> as the block host
            const pre = el.parentElement;
            // Migrate x-code attribute up to pre so the structure is uniform
            if (!pre.hasAttribute('x-code')) {
                pre.setAttribute('x-code', el.getAttribute('x-code') || '');
            }
            await setupBlock(pre, hljs);
        } else {
            // Arbitrary element (div, span, etc.) — treat as inline
            await setupInline(el, hljs);
        }
    } catch { /* highlight / setup failure — leave the block as plain text */ }
}

// ─── Code groups (tab strip across [name] siblings) ──────────────────────────

// A <pre|div x-code-group> wrapper coordinates tabs across its [name] children.
// Each code panel is a full <pre x-code> block run through setupBlock. Feature
// attrs (lines/edit/collapse) inherit from wrapper to children that don't set
// them; children that do win. `copy` is NOT inherited — a single wrapper-level
// copy button targets the active panel instead.
const GROUP_INHERITABLE_ATTRS = ['lines', 'edit', 'collapse'];

async function setupCodeGroup(group) {
    if (group.dataset.groupProcessed === 'yes') return;

    // Panels are children with [name]; children without are ambient (always
    // visible). No names → borderless wrapper around its kids, no tabs.
    const sourcePanels = Array.from(group.children).filter(c => c.hasAttribute('name'));
    const ambientChildren = Array.from(group.children).filter(c => !c.hasAttribute('name'));
    if (sourcePanels.length === 0 && ambientChildren.length === 0) return;
    // Claim synchronously so re-entrant callers (directive + observer) bail out.
    group.dataset.groupProcessed = 'yes';

    // Inherit feature attributes to child <pre x-code> that don't set them.
    // Run BEFORE setupBlock so inherited attrs drive its setup.
    const allCodeChildren = [...sourcePanels, ...ambientChildren].filter(c => c.tagName === 'PRE');
    for (const panel of allCodeChildren) {
        for (const attr of GROUP_INHERITABLE_ATTRS) {
            if (group.hasAttribute(attr) && !panel.hasAttribute(attr)) {
                panel.setAttribute(attr, group.getAttribute(attr));
            }
        }
    }

    // Ordered unique tab names. Panels may share a name (frame + code co-visible).
    const tabNames = [];
    for (const p of sourcePanels) {
        const n = p.getAttribute('name');
        if (!tabNames.includes(n)) tabNames.push(n);
    }
    const active = tabNames[0];
    const slugify = s => s.replace(/\s+/g, '-').toLowerCase();

    // Preload hljs + every language across the group so each setupBlock can
    // highlight synchronously.
    const codeLangs = allCodeChildren
        .filter(p => p.hasAttribute('x-code'))
        .map(p => p.getAttribute('x-code'))
        .filter(Boolean);
    let hljs = null;
    if (codeLangs.length > 0) {
        hljs = await loadHighlightJS(codeLangs[0]);
        for (const l of codeLangs.slice(1)) await registerLanguage(l);
    }

    // Normalize wrapper to <pre> for CSS uniformity. When converting from
    // <div>, transplant children so their Alpine-wired identity stays valid.
    let pre;
    if (group.tagName === 'PRE') {
        pre = group;
    } else {
        pre = document.createElement('pre');
        for (const a of group.attributes) pre.setAttribute(a.name, a.value);
        while (group.firstChild) pre.appendChild(group.firstChild);
        group.replaceWith(pre);
    }
    pre.dataset.groupProcessed = 'yes';
    if (!pre.hasAttribute('role')) pre.setAttribute('role', 'region');

    // Run each code child through setupBlock for full feature treatment.
    // Frames stay as-is; setupBlock suppresses the per-panel title bar in a group.
    for (const panel of allCodeChildren) {
        if (panel.hasAttribute('x-code')) {
            await setupBlock(panel, hljs);
            panel.dataset.codeProcessed = 'yes';
        }
    }

    // Header: tab strip for multiple named panels, plain title bar for one,
    // none when nothing is named.
    const isSingleTab = tabNames.length === 1;
    const isHeaderless = tabNames.length === 0;
    let header = null;
    let tablist = null;
    let tabButtons = [];
    if (!isHeaderless) header = document.createElement('header');
    if (isSingleTab) {
        const titleEl = document.createElement('div');
        titleEl.textContent = active;
        header.appendChild(titleEl);
        if (!pre.hasAttribute('aria-label')) pre.setAttribute('aria-label', active);
    } else if (!isHeaderless) {
        // role=tablist on an inner <div> so it can overflow-x scroll on its own.
        // `unstyle` opts out of manifest.form.css's generic tab styling.
        tablist = document.createElement('div');
        tablist.className = 'unstyle';
        tablist.setAttribute('role', 'tablist');
        tablist.setAttribute('aria-label', 'Code examples');
        header.appendChild(tablist);

        tabButtons = tabNames.map((name, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('role', 'tab');
            btn.id = `${slugify(name)}-tab-${i}`;
            btn.textContent = name;
            btn.setAttribute('aria-selected', name === active ? 'true' : 'false');
            btn.tabIndex = name === active ? 0 : -1;
            btn.addEventListener('click', () => activate(name));
            tablist.appendChild(btn);
            return btn;
        });
        tabButtons.forEach((btn, idx) => {
            btn.addEventListener('keydown', (ev) => {
                if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
                    ev.preventDefault();
                    const next = ev.key === 'ArrowRight'
                        ? (idx + 1) % tabButtons.length
                        : (idx - 1 + tabButtons.length) % tabButtons.length;
                    tabButtons[next].focus();
                    tabButtons[next].click();
                } else if (ev.key === 'Home') {
                    ev.preventDefault(); tabButtons[0].focus(); tabButtons[0].click();
                } else if (ev.key === 'End') {
                    ev.preventDefault(); tabButtons[tabButtons.length - 1].focus(); tabButtons[tabButtons.length - 1].click();
                }
            });
        });
    }
    if (header) pre.insertBefore(header, pre.firstChild);

    // Wire ARIA / IDs. Multi-tab: role="tabpanel" + aria-labelledby its tab.
    // Single-tab keeps the region shape (no orphan tabpanel without a tablist).
    sourcePanels.forEach((panel, i) => {
        const name = panel.getAttribute('name');
        panel.id = panel.id || `${slugify(name)}-panel-${i}`;
        if (!isSingleTab) {
            const tabBtn = tabButtons[tabNames.indexOf(name)];
            panel.setAttribute('role', 'tabpanel');
            if (tabBtn && !panel.hasAttribute('aria-labelledby')) {
                panel.setAttribute('aria-labelledby', tabBtn.id);
            }
        }
    });

    // Wrapper-level copy button — created when [copy] is on the wrapper or any
    // panel. Appended as a direct child of <pre> so it can position over the
    // top-end without competing with the header's scroll region.
    const wrapperHasCopy = pre.hasAttribute('copy');
    const anyPanelCopy = [...sourcePanels, ...ambientChildren].some(p => p.hasAttribute('copy'));
    let copyBtn = null;
    if (wrapperHasCopy || anyPanelCopy) {
        copyBtn = document.createElement('button');
        copyBtn.className = 'copy';
        copyBtn.type = 'button';
        copyBtn.setAttribute('aria-label', 'Copy code to clipboard');
        copyBtn.addEventListener('click', async () => {
            // Prefer the <pre x-code> panel for copy (its source, not a frame's
            // rendered text). Headerless groups pick the first ambient <pre x-code>.
            let activePanel;
            if (isHeaderless) {
                activePanel = ambientChildren.find(p => p.tagName === 'PRE' && p.hasAttribute('x-code'));
            } else {
                const sameName = sourcePanels.filter(p => p.getAttribute('name') === activeName);
                activePanel = sameName.find(p => p.tagName === 'PRE' && p.hasAttribute('x-code')) || sameName[0];
            }
            if (!activePanel) return;
            const code = activePanel.querySelector(':scope > code') || activePanel;
            try {
                await navigator.clipboard.writeText(code.textContent);
                copyBtn.classList.add('copied');
                setTimeout(() => copyBtn.classList.remove('copied'), 1500);
            } catch { /* clipboard rejected (browser permissions) — fail silently */ }
        });
        pre.appendChild(copyBtn);
    }

    // Visibility toggle via style.display (pre's display:flex outweighs the UA
    // [hidden] rule). Also flips per-tab copy-button visibility when [copy] is
    // per-panel rather than on the wrapper.
    let activeName = active;
    function activate(name) {
        activeName = name;
        tabButtons.forEach(btn => {
            const isActive = btn.textContent === name;
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
            btn.tabIndex = isActive ? 0 : -1;
        });
        sourcePanels.forEach(panel => {
            panel.style.display = panel.getAttribute('name') === name ? '' : 'none';
        });
        if (copyBtn) {
            const activeCanCopy = wrapperHasCopy || sourcePanels
                .filter(p => p.getAttribute('name') === name)
                .some(p => p.hasAttribute('copy'));
            copyBtn.style.display = activeCanCopy ? '' : 'none';
        }
    }
    if (!isHeaderless) activate(active);
}

// ─── Page scan + observation ─────────────────────────────────────────────────

// Promote markdown's <pre><code class="language-X"> to first-class hosts by
// setting x-code on the <pre>. Accepts a Document/Element (scans) or one <pre>.
function adoptMarkdownBlocks(root = document) {
    if (root && root.tagName === 'PRE' && !root.hasAttribute('x-code')) {
        const code = root.querySelector(':scope > code[class*="language-"]');
        if (!code) return;
        const match = code.className.match(/language-([\w-]+)/);
        root.setAttribute('x-code', match ? match[1] : '');
        if (!root.hasAttribute('name') && root.hasAttribute('title')) {
            root.setAttribute('name', root.getAttribute('title'));
        }
        return;
    }
    const candidates = root.querySelectorAll('pre:not([x-code]):not([data-code-processed]) > code[class*="language-"]');
    for (const code of candidates) {
        const pre = code.parentElement;
        if (!pre) continue;
        const match = code.className.match(/language-([\w-]+)/);
        const lang = match ? match[1] : '';
        pre.setAttribute('x-code', lang);
        if (!pre.hasAttribute('name') && pre.hasAttribute('title')) {
            pre.setAttribute('name', pre.getAttribute('title'));
        }
    }
}

// Per-element IntersectionObserver — process each block only when it nears the
// viewport. Keeps hidden SPA routes from prematurely escalating the loader to
// full mode, and defers highlight cost on long pages.
let codeIO = null;

function ensureObserver() {
    if (codeIO) return codeIO;
    codeIO = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            // During Alpine boot the IO can fire "intersecting" before the router
            // applies display:none. checkVisibility() is the source of truth;
            // if hidden, leave it observed to re-fire on a future route change.
            const t = entry.target;
            if (typeof t.checkVisibility === 'function' && !t.checkVisibility()) continue;
            observer.unobserve(t);
            handleVisible(t);
        }
    }, { rootMargin: '100px', threshold: 0 });
    return codeIO;
}

function handleVisible(el) {
    // Once one block crosses into view, eagerly process every currently-visible
    // candidate so highlighting doesn't "pop" in during scroll. Below-the-fold
    // and hidden-route candidates stay observed for later.
    const candidates = document.querySelectorAll(
        '[x-code]:not([data-code-processed]),' +
        '[x-code-group]:not([data-group-processed]),' +
        'pre:not([x-code]):not([data-code-processed]) > code[class*="language-"],' +
        // Copy-only inline codespans (`text`{copy}); skip x-code and in-pre ones.
        'code[copy]:not([x-code]):not([data-code-processed]):not(pre > code)'
    );
    // Always include the triggering element (it's already known to be visible).
    processOne(el);
    for (const c of candidates) {
        if (c === el) continue;
        const visible = typeof c.checkVisibility === 'function' ? c.checkVisibility() : true;
        if (!visible) continue;
        codeIO && codeIO.unobserve(c);
        processOne(c);
    }
}

function processOne(el) {
    if (el.hasAttribute && el.hasAttribute('x-code-group')) {
        setupCodeGroup(el);
    } else if (el.hasAttribute && el.hasAttribute('x-code')) {
        processCodeElement(el);
    } else if (el.matches && el.matches('pre > code[class*="language-"]')) {
        adoptMarkdownBlocks(el.parentElement);
        processCodeElement(el.parentElement);
    } else if (el.tagName === 'CODE' && el.hasAttribute('copy')) {
        // Copy-only inline codespan — just wire click-to-copy.
        if (el.dataset.codeProcessed !== 'yes') {
            el.dataset.codeProcessed = 'yes';
            setupInlineCopy(el);
        }
    }
}

// Observe every unprocessed candidate in `root` (idempotent). Already-visible
// elements process immediately so markdown-injected blocks render synchronously
// instead of waiting for the next IO callback.
function observeAll(root = document) {
    const io = ensureObserver();
    const candidates = [
        ...root.querySelectorAll('[x-code]:not([data-code-processed])'),
        ...root.querySelectorAll('[x-code-group]:not([data-group-processed])'),
        ...root.querySelectorAll('pre:not([x-code]):not([data-code-processed]) > code[class*="language-"]'),
        // Copy-only inline codespans (`text`{copy}) — copy handler only.
        ...root.querySelectorAll('code[copy]:not([x-code]):not([data-code-processed]):not(pre > code)')
    ];
    for (const el of candidates) {
        io.observe(el);
        // Hidden elements stay observed to highlight when later revealed.
        if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue;
        io.unobserve(el);
        processOne(el);
    }
}

// Re-scan after markdown injections (the markdown plugin dispatches this
// when a fenced-code render is appended to the DOM).
function onCodeBlocksConverted() {
    observeAll();
}

// ─── Initialization ──────────────────────────────────────────────────────────

let codePluginInitialized = false;

function registerAlpine() {
    if (typeof Alpine === 'undefined' || typeof Alpine.directive !== 'function') return;
    if (window.__manifestCodeDirectivesRegistered) return;
    window.__manifestCodeDirectivesRegistered = true;

    // `x-code` on any element — observe rather than process, so hidden routes
    // don't run hljs until navigated to.
    Alpine.directive('code', (el) => {
        if (el.dataset.codeProcessed === 'yes') return;
        ensureObserver().observe(el);
    });

    // `x-code-group` wrapper; tabs across [name] children.
    Alpine.directive('code-group', (el) => {
        if (el.dataset.groupProcessed === 'yes') return;
        ensureObserver().observe(el);
    });
}

async function ensureCodePluginInitialized() {
    if (codePluginInitialized) return;
    codePluginInitialized = true;

    registerAlpine();
    document.addEventListener('alpine:init', registerAlpine);

    // Markdown plugin hand-off
    document.addEventListener('manifest:code-blocks-converted', onCodeBlocksConverted);
    if (document.body) {
        document.body.addEventListener('manifest:code-blocks-converted', onCodeBlocksConverted);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => observeAll());
    } else {
        observeAll();
    }

    // Re-observe after SPA route changes so newly-visible routes' blocks
    // are picked up (Alpine directives already fired on initial mount).
    window.addEventListener('manifest:route-change', () => observeAll());
}

window.ensureCodePluginInitialized = ensureCodePluginInitialized;

// Expose select internals for the markdown plugin and other consumers.
window.ManifestCode = {
    loadHighlightJS,
    loadCodeJar,
    processCodeElement,
    setupCodeGroup,
    observeAll
};

ensureCodePluginInitialized();
