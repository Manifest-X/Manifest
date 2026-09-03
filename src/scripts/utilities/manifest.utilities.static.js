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

// Top-level selector text only (skips declaration bodies, so values like
// `margin: .5rem` can't be mistaken for a `.5` class selector).
TailwindCompiler.prototype.extractSelectorsFromCssText = function (cssText) {
    const selectors = [];
    const len = cssText.length;
    let i = 0;
    while (i < len) {
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

// Selectors escape every non-alphanumeric/hyphen char (see escapeClassName),
// so `.hover\:bg-brand` unescapes back to the `hover:bg-brand` token form
// used everywhere else (class attributes, usedClasses, parseClassName).
TailwindCompiler.prototype.classNamesFromCssText = function (cssText) {
    const classSet = new Set();
    const classRe = /\.((?:\\.|[a-zA-Z0-9_-])+)/g;
    for (const selector of this.extractSelectorsFromCssText(cssText)) {
        let m;
        classRe.lastIndex = 0;
        while ((m = classRe.exec(selector)) !== null) {
            classSet.add(m[1].replace(/\\(.)/g, '$1'));
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
    const el = this.findStaticUtilitiesElement();
    if (!el) return Promise.resolve();

    if (el.tagName === 'STYLE') {
        this.staticUtilitiesCoveredClasses = this.classNamesFromCssText(el.textContent || '');
        return Promise.resolve();
    }

    const covered = this.readStaticUtilitiesRules(el);
    if (covered) {
        this.staticUtilitiesCoveredClasses = covered;
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            el.removeEventListener('load', onLoad);
            el.removeEventListener('error', onError);
            // staticUtilitiesCoveredClasses stays null (fail open) if this
            // still can't be read — e.g. a cross-origin sheet without CORS.
            this.staticUtilitiesCoveredClasses = this.readStaticUtilitiesRules(el);
            resolve();
        };
        const onLoad = () => finish();
        const onError = () => finish();
        const timer = setTimeout(finish, 2000);
        el.addEventListener('load', onLoad, { once: true });
        el.addEventListener('error', onError, { once: true });
    });
};

// Drop classes already covered by the static sheet before generating rules
// for them again — the JIT should only ever patch what's left uncovered.
TailwindCompiler.prototype.filterStaticallyCoveredClasses = function (classes) {
    const covered = this.staticUtilitiesCoveredClasses;
    if (!covered || covered.size === 0) return classes;
    return classes.filter(c => !covered.has(c));
};

// The localStorage cache (manifest.utilities.cache.js) stores a full compiled
// stylesheet from a previous visit — one that may predate the static sheet, or
// come from a visitor without one. Re-applying it verbatim would re-emit every
// rule the static sheet already covers, so strip those rules out first.
TailwindCompiler.prototype.stripCoveredRulesFromCss = function (cssText) {
    const covered = this.staticUtilitiesCoveredClasses;
    if (!covered || covered.size === 0 || !cssText) return cssText;

    const strip = (text) => {
        const out = [];
        const len = text.length;
        let i = 0;
        while (i < len) {
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
            const classRe = /\.((?:\\.|[a-zA-Z0-9_-])+)/g;
            let cm;
            while ((cm = classRe.exec(selector)) !== null) {
                classes.push(cm[1].replace(/\\(.)/g, '$1'));
            }
            // Only drop a rule once every class it references is covered — a
            // mixed selector (`:where(.row, .col)`) stays if either is new.
            const isFullyCovered = classes.length > 0 && classes.every(c => covered.has(c));
            if (!isFullyCovered) out.push(fullRule);
        }
        return out.join('\n');
    };

    return strip(cssText);
};
