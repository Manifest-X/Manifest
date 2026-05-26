/*  Manifest Code
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  With reference to:
/*  - highlight.js (https://highlightjs.org)
/*  - CodeJar       (https://github.com/antonmedv/codejar)
/*
/*  Requires Alpine JS (alpinejs.dev) to operate.
/*
/*  Public API
/*  ----------
/*  <pre x-code>                               Block; auto-detect language
/*  <pre x-code="javascript">                  Block; explicit language
/*  <pre x-code="javascript" lines copy>       Line numbers + floating copy button
/*  <pre x-code="javascript" name="API call">  Adds a header/title bar
/*  <pre x-code="javascript" collapse>         Collapsed when long; default 20 lines
/*  <pre x-code="javascript" collapse="10">    Collapsed to first 10 lines
/*  <pre x-code="javascript" edit>             CodeJar-powered editor
/*  <pre x-code="html" from="#demo-id">        Content sourced from another element's innerHTML
/*
/*  <code x-code="bash">npm i mnfst</code>     Inline; highlighted in place
/*  <code x-code="bash" copy>npm i mnfst</code>Inline; click-to-copy
/*
/*  <div x-code-group>                         Tab strip across direct children with [name]
/*    <aside class="frame" name="HTML">…       Frame is a tab panel
/*    <pre x-code="html" name="HTML">…         Code block is a tab panel
/*    …                                        Children without [name] are always visible
/*  </div>
*/

// ─── Library loaders ─────────────────────────────────────────────────────────

// Highlight.js loading is a two-mode affair:
//
//   Lean mode (preferred):  core.min.js (~8 KB gz) + one language module
//                           (~2-7 KB gz each, depending on grammar) per
//                           distinct language on the page. Used when every
//                           code block declares an explicit language.
//                           Loaded via ESM dynamic imports from esm.run
//                           (jsDelivr's CJS→ESM transpiler); the npm
//                           package's lib/core and lib/languages/* are
//                           CommonJS-only, so we go through esm.run to
//                           get browser-native ESM.
//
//   Full mode (fallback):   highlight.min.js (~42 KB gz with ~36 common
//                           languages, IIFE-wrapped). Used when any block
//                           requests auto-detect (empty/auto x-code value)
//                           since hljs needs the whole language set to
//                           pick. Loaded as a classic <script> from
//                           cdn-release because it's the only build with
//                           the languages baked in.
//
// We decide once on first call by scanning the page. If a later markdown
// injection introduces an auto-detect block, the next loadHighlightJS()
// transparently switches to full mode — the prior core load is harmless
// (hljs is a single global namespace, the full bundle overwrites it).

const HLJS_FULL_URL = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/highlight.min.js';
// esm.run resolves extension-less specifiers; including ".js" triggers a
// deprecation warning at module-evaluation time.
const HLJS_CORE_URL = 'https://esm.run/highlight.js@11.11.1/lib/core';
const HLJS_LANG_BASE = 'https://esm.run/highlight.js@11.11.1/lib/languages/';

let hljsCorePromise = null;
let hljsFullPromise = null;
const langLoadPromises = new Map();
// Becomes true once we've committed to the full bundle (any auto-detect
// block, any language-module load failure). Once flipped, never resets —
// we keep using the full bundle for the rest of the page lifecycle.
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

// Sentinel used by both loaders to detect whether `window.hljs` is already
// the FULL bundle (which registers ~190 languages) vs the lean core (which
// starts with very few). Threshold of 50 separates the two reliably —
// neither the lean core nor any realistic per-language top-up will reach
// 50 languages before the full bundle does, and the full bundle always
// ships well above that.
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
    // Don't downgrade. If the full bundle is already loaded on window.hljs
    // (because the hero editor — or any other caller — asked for full mode
    // first), returning the lean core would mean OVERWRITING window.hljs
    // with a 4-language instance, deleting the full bundle's grammars.
    // Per-block callers downstream would then re-request languages,
    // re-fire reactive bumps, and feed an Alpine re-eval loop. Just hand
    // back the full instance — registerLanguage's "already includes"
    // check below makes the rest of the lean path a no-op.
    if (hljsIsFullBundle()) return window.hljs;
    if (hljsCorePromise) return hljsCorePromise;
    hljsCorePromise = import(HLJS_CORE_URL).then(mod => {
        // esm.run's CJS→ESM shim exposes hljs as the default export. Mirror
        // it onto window so existing call sites (Alpine evaluator, the hero
        // editor, etc.) that read `hljs` as a global keep working.
        const hl = mod.default;
        if (!hl) throw new Error('hljs undefined after core ESM import');
        // Second guard: even after we awaited the dynamic import, the full
        // bundle may have arrived in the meantime (its <script> tag races
        // our ESM fetch). Don't clobber it with the lean core.
        if (hljsIsFullBundle()) return window.hljs;
        window.hljs = hl;
        return hl;
    });
    return hljsCorePromise;
}

async function registerLanguage(lang) {
    if (!lang || lang === 'auto') return;
    const resolved = LANGUAGE_ALIASES[lang] || lang;
    const core = await loadHighlightCore();
    if (core.listLanguages().includes(resolved)) return;
    if (langLoadPromises.has(resolved)) return langLoadPromises.get(resolved);
    const p = import(`${HLJS_LANG_BASE}${resolved}`)
        .then(mod => { core.registerLanguage(resolved, mod.default); })
        .catch(() => {
            // If a language module fails to load (typo, network, deprecated
            // grammar, etc.) the next call will fall back to the full bundle
            // so the block at least renders with auto-detect.
            usingFullBundle = true;
            langLoadPromises.delete(resolved);
        });
    langLoadPromises.set(resolved, p);
    return p;
}

// Public entry point. Called per code block with the block's requested
// language (or null/empty for auto-detect). Returns hljs ready to highlight
// `requestedLang`, or to auto-detect if we're in full mode.
async function loadHighlightJS(requestedLang = null) {
    // Once we've committed to the full bundle (a prior block needed
    // auto-detect, or a language module load failed) every subsequent
    // call funnels through it.
    if (usingFullBundle || hljsFullPromise) return loadHighlightFull();
    // A per-block call asking for auto-detect → escalate.
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
    // codejar@4.3.0 ships as an ESM-only module. Import dynamically and expose
    // on window for downstream consumers (e.g. the hero-editor demo).
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

// Tell the utilities plugin to ignore code-related classes / elements so its
// utility-class scanner doesn't fight with hljs's mutations.
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

// Common shortenings that authors expect to work. highlight.js accepts most of
// these via its own alias system, but we resolve here so we can short-circuit
// the supported-language check before calling hljs.
const LANGUAGE_ALIASES = {
    js: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby',
    sh: 'bash', shell: 'bash', yml: 'yaml', html: 'xml', svg: 'xml'
};

function resolveLanguage(hljs, langAttr) {
    if (!langAttr || langAttr === 'auto') return null;
    const lang = LANGUAGE_ALIASES[langAttr] || langAttr;
    return hljs.listLanguages().includes(lang) ? lang : null;
}

// ─── Content prep helpers ────────────────────────────────────────────────────

// Drop any leading/trailing blank lines (including pure-whitespace lines).
// Authors typically write <pre x-code> on its own line, leaving stray newlines
// that throw off line numbering and the collapse threshold. Stripping multiple
// also covers the case where authors leave a blank line before </pre> for
// readability, which would otherwise render as a visible trailing gap.
function trimWrappingNewlines(text) {
    return text.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
}

// Remove the smallest common leading-whitespace block from every non-empty
// line. Sourced text that came indented under HTML markup looks indented
// inside the code block too, which is rarely what the author wants.
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

// Resolve the content for an element, honouring `from="#id"` (which reads the
// referenced element's innerHTML, preserving HTML markup as the rendered
// source) before falling back to the host element's own content.
//
// HTML examples are the special case: authors expect to write the literal
// markup (`<button>`, `<div>` etc.) without entity-escaping every char. The
// browser parses those into real DOM nodes inside the <pre>, so textContent
// would only see "ClickMe" instead of `<button>ClickMe</button>`. Reading
// innerHTML serialises the DOM back to source text, and a textarea-based
// decode unwraps any `&lt;`/`&gt;` entities so mixed-style authoring also
// works. For non-HTML languages we keep textContent — JS/CSS/etc. content
// rarely contains tags, and innerHTML would re-encode any entities the
// author DID write back as &lt; (preserving them in the highlighted output
// as literal text, which is wrong).
function resolveSource(el) {
    const fromRef = el.getAttribute('from');
    if (fromRef) {
        const target = document.querySelector(fromRef);
        if (target) return prepSource(target.innerHTML);
    }
    const lang = (el.getAttribute('x-code') || el.getAttribute('language') || '').toLowerCase();
    // Markdown plugin emits <pre x-code="lang"><code>source</code></pre>. The
    // <code> body is text-only (entity-escaped HTML decoded by the browser
    // into a text node), so textContent returns the exact source the author
    // wrote — preserving valueless attributes (data-tailwind, not
    // data-tailwind=""), multi-line attribute lists, and other formatting
    // that an innerHTML round-trip would normalise away.
    const childCode = el.querySelector(':scope > code');
    if (childCode) {
        return prepSource(childCode.textContent);
    }
    // Raw HTML case: the author wrote `<pre x-code="html"><div…></div></pre>`
    // directly in an .html file. Read innerHTML and decode any entities so
    // mixed-style authoring still works — but valueless attributes will pick
    // up the browser's `=""` normalisation here, which is unavoidable once
    // the markup has been parsed into real DOM nodes. Authors who want exact
    // source preservation should use a fenced markdown block or write the
    // body as entity-escaped text inside the pre.
    if (HTML_LIKE_LANGS.has(lang)) {
        const decoder = document.createElement('textarea');
        decoder.innerHTML = el.innerHTML;
        return prepSource(decoder.value);
    }
    return prepSource(el.textContent);
}

// hljs aliases (resolved upstream) map to "xml" internally, but authors may
// type any of these. Keep them all in the set so the source-reading path
// behaves the same regardless of the spelling used in the attribute.
const HTML_LIKE_LANGS = new Set(['html', 'xml', 'svg', 'xhtml', 'rss', 'atom']);

// ─── Highlighting ────────────────────────────────────────────────────────────

// Apply syntax highlighting to a <code> element's textContent. Returns the
// language hljs actually used (or null when no highlighting was applied), so
// callers can mark the host element accordingly.
function highlightInto(codeEl, source, hljs, requestedLang) {
    const lang = resolveLanguage(hljs, requestedLang);
    if (lang) {
        const result = hljs.highlight(source, { language: lang, ignoreIllegals: true });
        codeEl.innerHTML = result.value;
        codeEl.className = `hljs language-${lang}`;
        codeEl.dataset.highlighted = 'yes';
        return lang;
    }
    // Auto-detect path. Skip when the content looks like HTML markup — hljs
    // logs a noisy warning for content that contains < and > in close
    // proximity, which fires constantly on any HTML-fragment example.
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
            // Progressive enhancement: when the tooltip plugin is loaded and
            // the author hasn't already bound an x-tooltip to this element,
            // flash the copied-icon in a tooltip as confirmation. Skipped
            // entirely if either condition isn't met — the .copied class
            // toggle above is always the baseline feedback.
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
    // Build-once guard. setupBlock can reach this function from two paths
    // (processCodeElement for standalone, setupCodeGroup for panels) and a
    // re-entry would read pre.textContent — which now includes the .lines
    // gutter's "1\n2\n…" — as fresh source, repeatedly prepending the
    // gutter digits to the code.
    if (pre.dataset.codeBlockBuilt === 'yes') return;
    pre.dataset.codeBlockBuilt = 'yes';

    const source = resolveSource(pre);
    const requested = pre.getAttribute('x-code') || pre.getAttribute('language');

    // Reset internal structure. We always rebuild deterministically so the
    // first call is the only one that lays anything out.
    pre.innerHTML = '';

    // ARIA: region + label when titled
    const title = pre.getAttribute('name') || pre.getAttribute('title');
    if (title && !pre.hasAttribute('aria-label')) pre.setAttribute('aria-label', title);
    if (!pre.hasAttribute('role')) pre.setAttribute('role', 'region');

    // Title bar — render only when not inside a code-group (the group's tab
    // strip already shows the [name], so a per-panel title bar would
    // duplicate it visually). The aria-label is set either way for assistive
    // tech.
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

    // Copy button (floating, top-end). Suppressed when this block is a
    // panel inside an [x-code-group] — the group itself owns the single
    // wrapper-level copy button (which targets the active panel) so the
    // affordance stays at the outermost container's top-end regardless
    // of which child(ren) carry [copy].
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

    // Expose the threshold to CSS so the max-height matches the visible-line
    // count exactly. Line-height in our typography is 1.5, so N lines === N
    // × 1.5em of content height (plus pre padding handled by the selector).
    pre.style.setProperty('--collapse-lines', String(collapseAt));
    pre.setAttribute('data-collapsed', '');

    const btn = document.createElement('button');
    btn.className = 'expand';
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    const hiddenCount = lineCount - collapseAt;
    // Visual label is locale-safe (no translatable strings) — "+N" reads
    // universally as "expand to see N more", "−" (U+2212 minus sign) as
    // "collapse". Screen readers receive an explicit English aria-label
    // so the action remains intelligible regardless of the visual glyph.
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
        // Some browsers (older Safari) don't support plaintext-only — fall back
        // to plain "true". CodeJar handles paste sanitization either way.
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
        // CodeJar applies white-space: pre-wrap. Our convention for code blocks
        // is true no-wrap (lines extend, parent scrolls), so override.
        code.style.whiteSpace = 'pre';
        // Expose the editor instance on the host so consumers (e.g. the hero
        // editor) can wire onUpdate / updateCode / save / restore without
        // re-mounting CodeJar themselves.
        pre._codeJar = editor;
        pre.dispatchEvent(new CustomEvent('code:editor-ready', { detail: { editor } }));
    } catch { /* CodeJar load / mount failed — fail silently */ }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

// Process one host element. Routes to inline vs block based on tag.
async function processCodeElement(el) {
    if (el.dataset.codeProcessed === 'yes') return;
    // Group-owned panels are handled wholesale by setupCodeGroup: each
    // <pre x-code> sibling is consumed into a <code> child of the new
    // group wrapper. Skip here so we don't double-process / re-parent.
    if (el.parentElement && el.parentElement.hasAttribute('x-code-group')) return;
    el.dataset.codeProcessed = 'yes';

    try {
        // Pass the requested language to the loader so it can stay in lean
        // mode (core + only this language) when the rest of the page only
        // uses explicit languages too.
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

// Build the canonical group structure:
//
//   <pre x-code-group>                         ← wrapper coordinates tabs
//     <header role=tablist>                      (a <div x-code-group> source
//       <button role=tab>HTML</button>           is normalized to <pre> at
//       <button role=tab>CSS</button>            process time)
//     </header>
//     <pre x-code="html" name=HTML role=tabpanel>...full block...</pre>
//     <pre x-code="css"  name=CSS  role=tabpanel style="display:none">...</pre>
//     <aside class=frame name=Preview role=tabpanel style="display:none">...</aside>
//     <button.copy>                              ← present when wrapper has [copy]
//   </pre>
//
// Each code panel is a full <pre x-code> block with its own line numbers,
// collapse toggle, editor — i.e. it runs through setupBlock. The wrapper
// inherits per-panel feature attributes (lines, edit, collapse) to child
// panels that don't set them, so:
//
//   <pre x-code-group lines>
//     <pre x-code="html" name=HTML>...</pre>
//     <pre x-code="css"  name=CSS>...</pre>
//   </pre>
//
// behaves as if each child had `lines` written on it directly. Children
// that DO set the attribute (or set it to a different value, e.g. per-panel
// collapse="5") win over inheritance.
//
// `copy` is NOT inherited — instead, when present on the wrapper, the
// plugin attaches a single copy button to the wrapper itself that targets
// whichever panel is currently active. This keeps the button on the
// element that actually carries the [copy] attribute, and avoids the
// visual clutter of one button per tab.
const GROUP_INHERITABLE_ATTRS = ['lines', 'edit', 'collapse'];

async function setupCodeGroup(group) {
    if (group.dataset.groupProcessed === 'yes') return;

    // A "panel" is any direct child with a [name] — these are tab panels.
    // Children without [name] are ambient (always visible alongside whichever
    // panel is active). When nothing is named, the group has no tabs at all
    // and renders as a borderless wrapper around its (always-visible) kids —
    // a frame + code pair, for instance, with no title overhead.
    const sourcePanels = Array.from(group.children).filter(c => c.hasAttribute('name'));
    const ambientChildren = Array.from(group.children).filter(c => !c.hasAttribute('name'));
    if (sourcePanels.length === 0 && ambientChildren.length === 0) return;
    // Claim the group synchronously so re-entrant callers (the directive +
    // observer can both arrive before the first call's `await` resolves)
    // bail out — otherwise the wrapper accumulates duplicate tab strips.
    group.dataset.groupProcessed = 'yes';

    // Inherit feature attributes from wrapper to child <pre x-code> elements
    // that don't set them. Ambient (unnamed) pres inherit too, so a frame +
    // code pair in an unnamed group still benefits from group-level [lines]
    // / [edit] / [collapse]. Run BEFORE setupBlock so the inherited attrs
    // drive that block's setup.
    const allCodeChildren = [...sourcePanels, ...ambientChildren].filter(c => c.tagName === 'PRE');
    for (const panel of allCodeChildren) {
        for (const attr of GROUP_INHERITABLE_ATTRS) {
            if (group.hasAttribute(attr) && !panel.hasAttribute(attr)) {
                panel.setAttribute(attr, group.getAttribute(attr));
            }
        }
    }

    // Ordered unique tab names. Multiple panels may share a name (e.g. a
    // frame + a code block co-visible under one tab); each panel is shown
    // independently when its tab activates.
    const tabNames = [];
    for (const p of sourcePanels) {
        const n = p.getAttribute('name');
        if (!tabNames.includes(n)) tabNames.push(n);
    }
    const active = tabNames[0];
    const slugify = s => s.replace(/\s+/g, '-').toLowerCase();

    // Preload hljs + every language needed across the group (named panels +
    // ambient pres) so each block's setupBlock can synchronously highlight
    // without re-loading.
    const codeLangs = allCodeChildren
        .filter(p => p.hasAttribute('x-code'))
        .map(p => p.getAttribute('x-code'))
        .filter(Boolean);
    let hljs = null;
    if (codeLangs.length > 0) {
        hljs = await loadHighlightJS(codeLangs[0]);
        for (const l of codeLangs.slice(1)) await registerLanguage(l);
    }

    // Normalize wrapper to <pre>. Authors may write <div x-code-group> or
    // <pre x-code-group>; we always end up with a <pre> for CSS uniformity.
    // When converting from <div>, transplant children rather than re-creating
    // — the same <pre x-code> nodes that Alpine has wired up keep their
    // identity, so subsequent processOne calls (and any author refs into
    // them) stay valid.
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

    // Run each code child (named or ambient) through setupBlock so it gets
    // its full feature treatment (line numbers, copy button, collapse,
    // editor). Frames stay as-is. setupBlock detects the [x-code-group]
    // ancestor and suppresses the per-panel title bar — the group header
    // (when present) serves that role; for headerless groups, the pre is
    // simply rendered without its own title.
    for (const panel of allCodeChildren) {
        if (panel.hasAttribute('x-code')) {
            await setupBlock(panel, hljs);
            panel.dataset.codeProcessed = 'yes';
        }
    }

    // Header: tab strip when there are multiple named panels, plain title bar
    // when there's just one, no header at all when nothing is named. Skipping
    // the header for headerless groups lets authors pair a frame + code block
    // inside <div x-code-group> with no repetitive "HTML" title — both render
    // as ambient siblings inside the wrapper.
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
        // The role=tablist sits on an inner <div> that holds the tab buttons.
        // That way the tablist can have its own overflow-x scrolling (when
        // there are too many tabs to fit) without dragging sibling header
        // content into the scroll region. CSS targets the inner element via
        // [role="tablist"] — no extra class needed.
        tablist = document.createElement('div');
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

    // Wire ARIA / IDs on each panel. Multi-tab groups get role="tabpanel" with
    // aria-labelledby pointing at its tab button; single-tab groups keep the
    // standalone role="region" + aria-label shape (label set on the wrapper
    // above) so there's no orphan tabpanel without a tablist. Headerless
    // groups have no tabpanels — every child is ambient.
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

    // Wrapper-level copy button. Created when [copy] is on the wrapper OR on
    // any child panel — the button always lives at the group's top-end so
    // the affordance is in the same spot regardless of which child carries
    // [copy]. setupBlock suppresses the per-panel copy button when inside a
    // group (the inGroup check) so we never duplicate.
    //
    // Appended as a direct child of the <pre> (sibling to the header) so it
    // can be absolutely positioned over the top-end of the wrapper without
    // competing with the header's own overflow-scroll region. Same
    // positioning rule as for a standalone <pre x-code copy>.
    const wrapperHasCopy = pre.hasAttribute('copy');
    const anyPanelCopy = [...sourcePanels, ...ambientChildren].some(p => p.hasAttribute('copy'));
    let copyBtn = null;
    if (wrapperHasCopy || anyPanelCopy) {
        copyBtn = document.createElement('button');
        copyBtn.className = 'copy';
        copyBtn.type = 'button';
        copyBtn.setAttribute('aria-label', 'Copy code to clipboard');
        copyBtn.addEventListener('click', async () => {
            // When multiple panels share the active name (e.g. a paired
            // frame + code), prefer the <pre x-code> for copy — the source
            // is what an author wants to take, not the rendered frame's
            // text content. Headerless groups have no active name, so pick
            // the first ambient <pre x-code> child instead.
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

    // Visibility toggle. Explicit style.display rather than the [hidden]
    // attribute, because pre's display:flex from typography.css outweighs
    // the UA `[hidden] { display: none }` rule. Also flips the copy button
    // visibility per-tab: when [copy] sits on the wrapper it stays visible
    // for every tab; when it sits only on individual panels, the button
    // shows for tabs whose panels carry [copy] and hides for the rest.
    // Headerless groups have no tabs to switch, so activate() is a no-op.
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

// Markdown emits <pre><code class="language-X">…</code></pre>. Promote these
// to first-class hosts by setting x-code on the <pre> when we encounter them,
// so they flow through the same processor as authored <pre x-code> blocks.
// Accepts either a Document/Element (scans descendants) or a single <pre>
// element (adopts just that one).
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

// Per-element IntersectionObserver — each candidate processes on its own
// when it scrolls into view. This is important for two reasons:
//   1. SPA routes that aren't currently visible (display:none from the
//      router) shouldn't trigger loadHighlightJS for their hidden blocks.
//      A page-wide scan would scoop them up and an auto-detect block in a
//      hidden route would push the loader into full-bundle mode even
//      though the visible route is lean-mode eligible.
//   2. Long pages with many code blocks don't pay the highlight cost up
//      front — each block runs hljs only when it nears the viewport.
let codeIO = null;

function ensureObserver() {
    if (codeIO) return codeIO;
    codeIO = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            // The router uses display:none to hide inactive SPA routes. There's
            // a small window during initial Alpine boot where the IO's initial
            // entry for an element fires as "intersecting" before the router
            // has applied display:none. checkVisibility() is the source of
            // truth; if the element is actually hidden, leave it observed so
            // a future route change re-fires the IO when it becomes visible.
            const t = entry.target;
            if (typeof t.checkVisibility === 'function' && !t.checkVisibility()) continue;
            observer.unobserve(t);
            handleVisible(t);
        }
    }, { rootMargin: '100px', threshold: 0 });
    return codeIO;
}

function handleVisible(el) {
    // When any code element in the active route first crosses into view,
    // eagerly process every currently-visible candidate on the page. This
    // avoids the "popping" effect of incremental highlighting as the user
    // scrolls — once hljs is loaded, everything currently on screen gets
    // styled at once. Below-the-fold and hidden-route candidates stay
    // observed and process when they later become visible.
    const candidates = document.querySelectorAll(
        '[x-code]:not([data-code-processed]),' +
        '[x-code-group]:not([data-group-processed]),' +
        'pre:not([x-code]):not([data-code-processed]) > code[class*="language-"]'
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
    }
}

// Start observing every candidate in `root` that hasn't already been
// processed. Idempotent — re-observation of an already-observed element
// is a no-op per the IntersectionObserver spec. Elements that are already
// visible at call time are processed immediately, then unobserved — this
// makes markdown-plugin-injected blocks render synchronously instead of
// waiting for the next IO callback (which can stall in headless tests
// and feels laggy for live markdown updates).
function observeAll(root = document) {
    const io = ensureObserver();
    const candidates = [
        ...root.querySelectorAll('[x-code]:not([data-code-processed])'),
        ...root.querySelectorAll('[x-code-group]:not([data-group-processed])'),
        ...root.querySelectorAll('pre:not([x-code]):not([data-code-processed]) > code[class*="language-"]')
    ];
    for (const el of candidates) {
        io.observe(el);
        // Skip the immediate-process shortcut for elements that are hidden
        // (display:none route panels, off-screen drawers): keep them observed
        // so they highlight on the next intersection callback when revealed.
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

    // `x-code="language"` on any element. Alpine fires the callback once
    // when the element enters its tree. We don't process immediately —
    // observe instead, so a hidden route's blocks don't run hljs until the
    // user actually navigates there.
    Alpine.directive('code', (el) => {
        if (el.dataset.codeProcessed === 'yes') return;
        ensureObserver().observe(el);
    });

    // `x-code-group` on a wrapper element; sets up tabs across [name]
    // children. The wrapper has no expression value.
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

// Expose select internals so the markdown plugin and other consumers can hook
// in without re-implementing the loaders or processors.
window.ManifestCode = {
    loadHighlightJS,
    loadCodeJar,
    processCodeElement,
    setupCodeGroup,
    observeAll
};

ensureCodePluginInitialized();
