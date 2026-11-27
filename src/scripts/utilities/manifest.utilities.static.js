// Static utilities sheet detection
// Publish/render may ship a precompiled utilities sheet — `<link rel="stylesheet"
// data-mnfst-utilities>` or `<style data-mnfst-utilities>`. Read the classes it
// already covers once so compile() only generates/patches what's left.

TailwindCompiler.prototype.findStaticUtilitiesElement = function () {
    try {
        return document.querySelector('link[rel="stylesheet"][data-mnfst-utilities], style[data-mnfst-utilities]');
    } catch (e) {
        return null;
    }
};

// Every shipped utilities sheet: the publish bake plus mnfst-render's prerender sheets
TailwindCompiler.prototype.findStaticUtilitiesElements = function () {
    try {
        return Array.from(document.querySelectorAll('link[rel="stylesheet"][data-mnfst-utilities], style[data-mnfst-utilities], link[rel="stylesheet"][href*="prerender.tailwind.css"], link[rel="stylesheet"][href*="prerender.utilities.css"]'));
    } catch (e) {
        return [];
    }
};

TailwindCompiler.prototype.hasShippedUtilitiesSheet = function () {
    return this.findStaticUtilitiesElements().length > 0;
};

// Top-level selector text only (skips declaration bodies, so values like
// `margin: .5rem` can't be mistaken for a `.5` class selector).
TailwindCompiler.prototype.extractSelectorsFromCssText = function (cssText) {
    const selectors = [];
    const len = cssText.length;
    let i = 0;
    while (i < len) {
        if (cssText[i] === ' ' || cssText[i] === '\n' || cssText[i] === '\r' || cssText[i] === '\t') { i++; continue; }   // else an @-rule after a newline reads as a selector
        // Skip inter-rule whitespace first — without this, whitespace before an
        // `@layer`/`@media` (e.g. after a preceding `@layer base, ...;` statement
        // or sibling rule) leaves `i` off the '@', so the block below never fires
        // and the whole nested block is swallowed whole as one bogus selector,
        // losing every class inside it (real Tailwind/compileUtilities output is
        // always `@layer theme {...}` followed by `@layer utilities {...}`).
        while (i < len && /\s/.test(cssText[i])) i++;
        if (i >= len) break;
        if (cssText[i] === '/' && cssText[i + 1] === '*') {
            const end = cssText.indexOf('*/', i + 2);
            i = end === -1 ? len : end + 2;
            continue;
        }
        if (cssText[i] === '@') {
            let j = i;
            while (j < len && cssText[j] !== '{' && cssText[j] !== ';') j++;
            if (j >= len || cssText[j] === ';') { i = j + 1; continue; }
            i = j + 1;
            let depth = 1;
            const start = i;
            while (i < len && depth > 0) {
                if (cssText[i] === '{') depth++;
                else if (cssText[i] === '}') depth--;
                i++;
            }
            selectors.push(...this.extractSelectorsFromCssText(cssText.slice(start, i - 1)));
            continue;
        }
        const selStart = i;
        while (i < len && cssText[i] !== '{' && cssText[i] !== '}') i++;
        if (i >= len || cssText[i] === '}') { i++; continue; }
        const selector = cssText.slice(selStart, i).trim();
        i++;
        let depth = 1;
        while (i < len && depth > 0) {
            if (cssText[i] === '{') depth++;
            else if (cssText[i] === '}') depth--;
            i++;
        }
        if (selector) selectors.push(selector);
    }
    return selectors;
};

// Undo escapeClassName's per-char escaping, including the CSS hex-escape
// form used for a class whose first character can't appear bare at the start
// of an identifier — a leading digit. Real Tailwind/CSS.escape emit `\32 `
// (backslash + hex codepoint + one trailing space) for the '2' in `2xl:*`;
// a naive `\X` → `X` unescape corrupts this (leaves a stray "2" + space and
// drops the rest of the selector), so `2xl:` variants silently stopped being
// recognized as covered — caught by the corpus test (utilities-corpus.test.js).
TailwindCompiler.prototype.unescapeClassToken = function (token) {
    return token.replace(/\\([0-9a-fA-F]{1,6}) ?|\\(.)/g, (m, hex, ch) => hex ? String.fromCodePoint(parseInt(hex, 16)) : ch);
};

// Selectors escape every non-alphanumeric/hyphen char (see escapeClassName),
// so `.hover\:bg-brand` unescapes back to the `hover:bg-brand` token form
// used everywhere else (class attributes, usedClasses, parseClassName). The
// hex-escape alternative is tried first so `\32 ` is consumed as one unit
// rather than stopping at the literal digits.
TailwindCompiler.prototype.classNamesFromCssText = function (cssText) {
    const classSet = new Set();
    const classRe = /\.((?:\\[0-9a-fA-F]{1,6} ?|\\.|[a-zA-Z0-9_-])+)/g;
    for (const selector of this.extractSelectorsFromCssText(cssText)) {
        let m;
        classRe.lastIndex = 0;
        while ((m = classRe.exec(selector)) !== null) {
            classSet.add(this.unescapeClassToken(m[1]));
        }
    }
    return classSet;
};

// Attempt a synchronous CSSOM read of the static link's rules. Returns a Set
// of covered classes, or null when nothing could be read — a security error
// (cross-origin), an exception, a missing sheet, or zero rules (the link
// hasn't finished loading, or its sheet is genuinely empty). null is never
// distinguished from "empty": both fail open in filterStaticallyCoveredClasses
// / stripCoveredRulesFromCss, and neither is ever treated as "everything
// covered".
TailwindCompiler.prototype.readStaticUtilitiesRules = function (el) {
    try {
        const sheet = Array.from(document.styleSheets).find(s => s.ownerNode === el);
        const rules = sheet && sheet.cssRules;
        if (rules && rules.length > 0) {
            const cssText = Array.from(rules).map(r => r.cssText).join('\n');
            return this.classNamesFromCssText(cssText);
        }
    } catch (e) {
        // Cross-origin, or not yet parsed.
    }
    return null;
};

// Read the static sheet's covered classes once per page load. `<style>` and
// an already-loaded `<link>` resolve synchronously. A `<link>` that hasn't
// finished loading (or whose sheet can't be read yet) is awaited via its
// `load`/`error` event, capped at 2s, then re-read once more; the caller
// (compile()'s first run) awaits the returned promise so the very first
// compile decision sees an accurate covered set rather than a guess. Fails
// open the whole time — staticUtilitiesCoveredClasses stays null (nothing
// covered) until a read actually succeeds, never cached as "covered".
TailwindCompiler.prototype.detectStaticUtilitiesSheet = function () {
    this.staticUtilitiesCoveredClasses = null;
    const els = this.findStaticUtilitiesElements();
    if (!els.length) return Promise.resolve();

    const merge = (classes) => {
        if (!classes) return;
        if (!this.staticUtilitiesCoveredClasses) this.staticUtilitiesCoveredClasses = new Set();
        for (const c of classes) this.staticUtilitiesCoveredClasses.add(c);
    };

    return Promise.all(els.map((el) => {
        if (el.tagName === 'STYLE') {
            merge(this.classNamesFromCssText(el.textContent || ''));
            return null;
        }
        const covered = this.readStaticUtilitiesRules(el);
        if (covered) {
            merge(covered);
            return null;
        }
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                el.removeEventListener('load', onLoad);
                el.removeEventListener('error', onError);
                // Unreadable (e.g. cross-origin without CORS) stays uncounted: fail open
                merge(this.readStaticUtilitiesRules(el));
                resolve();
            };
            const onLoad = () => finish();
            const onError = () => finish();
            const timer = setTimeout(finish, 2000);
            el.addEventListener('load', onLoad, { once: true });
            el.addEventListener('error', onError, { once: true });
        });
    })).then(() => { });
};

// manifest.json's `utilities.safelist` (exact class names) / `utilities.patterns`
// (regex source strings) — classes a project knows are already baked (or
// intentionally safe to leave unbaked) even though a plain HTML/component
// scan can't find them, e.g. built from a runtime value
// (`:class="ok ? 'bg-green-500' : 'bg-amber-500'"`). Read once from the
// shared manifest.json fetch (already in flight for other plugins); fails
// open to "no safelist" so a bad/missing config never blocks anything.
TailwindCompiler.prototype.loadUtilitiesSafelist = async function () {
    this.safelistClasses = new Set();
    this.safelistPatterns = [];
    try {
        let manifest = window.__manifestLoaded || null;
        if (!manifest && window.__manifestPromise) manifest = await window.__manifestPromise;
        const cfg = manifest && typeof manifest === 'object' ? manifest.utilities : null;
        if (cfg && Array.isArray(cfg.safelist)) {
            for (const c of cfg.safelist) if (typeof c === 'string' && c) this.safelistClasses.add(c);
        }
        if (cfg && Array.isArray(cfg.patterns)) {
            for (const p of cfg.patterns) {
                if (typeof p !== 'string') continue;
                try { this.safelistPatterns.push(new RegExp(p)); } catch (e) { /* invalid pattern, ignore */ }
            }
        }
    } catch (e) {
        // Fail open: no manifest.json, or it couldn't be read.
    }
};

TailwindCompiler.prototype.isClassSafelisted = function (cls) {
    if (this.safelistClasses && this.safelistClasses.has(cls)) return true;
    if (this.safelistPatterns) {
        for (const re of this.safelistPatterns) {
            if (re.test(cls)) return true;
        }
    }
    return false;
};

// Single source of truth for "covered" everywhere that concept is used: the
// static sheet's own classes, or the safelist. Both mean "don't regenerate,
// and don't treat as a signal that the Tailwind engine needs to load".
TailwindCompiler.prototype.isClassCovered = function (cls) {
    const covered = this.staticUtilitiesCoveredClasses;
    if (covered && covered.has(cls)) return true;
    return this.isClassSafelisted(cls);
};

TailwindCompiler.prototype.hasSafelistEntries = function () {
    return !!((this.safelistClasses && this.safelistClasses.size) || (this.safelistPatterns && this.safelistPatterns.length));
};

// Drop classes already covered by the static sheet (or the safelist) before
// generating rules for them again — the JIT should only ever patch what's left.
TailwindCompiler.prototype.filterStaticallyCoveredClasses = function (classes) {
    const covered = this.staticUtilitiesCoveredClasses;
    if ((!covered || covered.size === 0) && !this.hasSafelistEntries()) return classes;
    const left = classes.filter(c => !this.isClassCovered(c));
    if (!this.bareClassesEmitRules(left.filter(c => !hasClassVariant(c)))) return left;
    // A bare class emitted last would beat its breakpoint partners in the shipped sheets
    // (text-3xl over md:text-5xl): re-emit the at-rule variant classes after it
    const out = new Set(left);
    const pageClasses = [classes, this.staticClassCache || [], this.dynamicClassCache || []];
    for (const list of pageClasses) for (const c of list) if (this.isAtRuleVariantClass(c)) out.add(c);
    return Array.from(out);
};

// Whether any of these bare classes actually generates a rule (author classes like `card` don't)
TailwindCompiler.prototype.bareClassesEmitRules = function (bare) {
    if (!bare.length) return false;
    const themeCss = this.lastThemeCss;
    if (!themeCss) return true;
    try {
        const probe = { classes: bare, variableSuffixes: [] };
        return !!((this.generateUtilitiesFromVars(themeCss, probe) || '').trim() || (this.generateCustomUtilities(probe) || '').trim());
    } catch (e) {
        return true;
    }
};

// Variant prefixes outside brackets (md:text-5xl, [&_p]:x — not w-[a:b])
function classVariantTokens(cls) {
    const parts = [];
    let depth = 0, current = '';
    for (const ch of cls) {
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        if (ch === ':' && depth === 0) { parts.push(current); current = ''; }
        else current += ch;
    }
    return parts;
}

function hasClassVariant(cls) {
    return classVariantTokens(cls).length > 0;
}

// Only media/container/supports conditions: same specificity as the bare class, so order decides
TailwindCompiler.prototype.isAtRuleVariantClass = function (cls) {
    const tokens = classVariantTokens(cls.replace(/^!/, ''));
    if (!tokens.length) return false;
    return tokens.every(t => {
        const sel = this.variants && this.variants[t];
        if (sel) return sel.startsWith('@');
        return t.startsWith('@') || /^(min-|max-)?(sm|md|lg|xl|2xl)$/.test(t) || /^(min|max)-\[.+\]$/.test(t);
    });
};

// The localStorage cache (manifest.utilities.cache.js) stores a full compiled
// stylesheet from a previous visit — one that may predate the static sheet, or
// come from a visitor without one. Re-applying it verbatim would re-emit every
// rule the static sheet already covers, so strip those rules out first.
TailwindCompiler.prototype.stripCoveredRulesFromCss = function (cssText) {
    const covered = this.staticUtilitiesCoveredClasses;
    if (!cssText || ((!covered || covered.size === 0) && !this.hasSafelistEntries())) return cssText;

    const strip = (text) => {
        const out = [];
        const len = text.length;
        let i = 0;
        while (i < len) {
            if (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t') { out.push(text[i]); i++; continue; }
            // Skip (but preserve) inter-rule whitespace before checking for an
            // at-rule — see extractSelectorsFromCssText for why this matters.
            const wsStart = i;
            while (i < len && /\s/.test(text[i])) i++;
            if (i > wsStart) out.push(text.slice(wsStart, i));
            if (i >= len) break;
            if (text[i] === '/' && text[i + 1] === '*') {
                const end = text.indexOf('*/', i + 2);
                const stop = end === -1 ? len : end + 2;
                out.push(text.slice(i, stop));
                i = stop;
                continue;
            }
            if (text[i] === '@') {
                let j = i;
                while (j < len && text[j] !== '{' && text[j] !== ';') j++;
                if (j >= len || text[j] === ';') { out.push(text.slice(i, j + 1)); i = j + 1; continue; }
                const atHead = text.slice(i, j + 1);
                i = j + 1;
                let depth = 1;
                const start = i;
                while (i < len && depth > 0) {
                    if (text[i] === '{') depth++;
                    else if (text[i] === '}') depth--;
                    i++;
                }
                out.push(`${atHead}${strip(text.slice(start, i - 1))}}`);
                continue;
            }
            const selStart = i;
            while (i < len && text[i] !== '{' && text[i] !== '}') i++;
            if (i >= len || text[i] === '}') { i++; continue; }
            const selector = text.slice(selStart, i).trim();
            const bodyStart = i;
            i++;
            let depth = 1;
            while (i < len && depth > 0) {
                if (text[i] === '{') depth++;
                else if (text[i] === '}') depth--;
                i++;
            }
            const fullRule = selector + text.slice(bodyStart, i);
            // Match tokens directly against the bare selector text — it has no
            // rule body for classNamesFromCssText's selector-then-`{` scan to key off.
            const classes = [];
            const classRe = /\.((?:\\[0-9a-fA-F]{1,6} ?|\\.|[a-zA-Z0-9_-])+)/g;
            let cm;
            while ((cm = classRe.exec(selector)) !== null) {
                classes.push(this.unescapeClassToken(cm[1]));
            }
            // Only drop a rule once every class it references is covered — a
            // mixed selector (`:where(.row, .col)`) stays if either is new.
            const isFullyCovered = classes.length > 0 && classes.every(c => this.isClassCovered(c));
            const isVariant = classes.some(c => this.isAtRuleVariantClass(c));
            if (!isFullyCovered) {
                out.push(fullRule);
                if (classes.length > 0 && !classes.some(hasClassVariant)) keptBare = true;
            } else if (keepVariants && isVariant) {
                out.push(fullRule);
            }
        }
        return out.join('\n');
    };

    // Kept bare rules sit last: keep the variant rules too so they still follow them
    let keepVariants = false;
    let keptBare = false;
    const stripped = strip(cssText);
    if (!keptBare) return stripped;
    keepVariants = true;
    return strip(cssText);
};

// Engine-skip gate (loader: decideTailwindStamp). Armed once the loader accepts the stamp and the sheet is read;
// after that each token is checked where it is first recorded. utilities.patterns never excuse a token here.
const FRAMEWORK_STATE_CLASSES = new Set(['dark', 'light', 'active', 'outside', 'copied', 'window-resizing', 'toast-entry', 'toast-exit',
    'time-options', 'range-start', 'range-end', 'in-range', 'date-picker', 'chart']);
const AUTHOR_TAILWIND_SELECTOR = 'style[type="text/tailwindcss"]:not(#manifest-tailwind-variants)';

TailwindCompiler.prototype.armEngineGate = function () {
    const stamp = window.__tailwindStamp;
    if (!stamp || !stamp.decision || this.usesStaticPrerenderUtilities) return;
    stamp.decision.then((accepted) => {
        if (!accepted || this._engineGate) return;
        this._engineGate = stamp;
        if (!this.staticUtilitiesCoveredClasses) return this.engineNeeded(null, 'sheet');
        if (document.querySelector(AUTHOR_TAILWIND_SELECTOR)) return this.engineNeeded(null, 'author-block');
        for (const set of [this.staticClassCache, this.dynamicClassCache]) {
            for (const cls of set) if (!this.checkEngineToken(cls)) return;
        }
    });
};

// False once a token needs the engine
TailwindCompiler.prototype.checkEngineToken = function (cls) {
    const gate = this._engineGate;
    if (!gate || gate.trigger) return true;
    if (gate.tokens.has(cls) || this.staticUtilitiesCoveredClasses.has(cls) || FRAMEWORK_STATE_CLASSES.has(cls)) return true;
    if (cls.startsWith('x-') || cls.startsWith('$') || this.ignoredClassPatterns.some(p => p.test(cls))) return true;
    this.engineNeeded(cls, 'token');
    return false;
};

// An added subtree carrying an author text/tailwindcss block
TailwindCompiler.prototype.checkEngineNode = function (node) {
    const gate = this._engineGate;
    if (!gate || gate.trigger) return;
    if (node.matches(AUTHOR_TAILWIND_SELECTOR) || (node.firstElementChild && node.querySelector(AUTHOR_TAILWIND_SELECTOR))) this.engineNeeded(null, 'author-block');
};

TailwindCompiler.prototype.engineNeeded = function (token, reason) {
    const gate = this._engineGate;
    if (gate && !gate.trigger) gate.needEngine(token, reason);
};
