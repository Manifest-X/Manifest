// Node/Workers wrapper — combined at build time (see build.mjs
// buildUtilitiesNodeModule) with the DOM-free subset of the browser plugin's
// subscripts (generators, variants, main, helpers, compile) so this exports
// the exact same generation logic the browser JIT runs, with no document.
//
// compileUtilities() also runs the real `tailwindcss` engine (see the
// "Tailwind engine pass" section below) — a real, lazily-imported dependency
// used only there, via Node's fs/require; every other export in this file
// stays dependency-free and DOM-free as before.

/** A bare TailwindCompiler instance carrying only what the pure generation
 * methods (generateUtilitiesFromVars, generateCustomUtilities, parseClassName,
 * ...) read from `this` — mirrors the constructor's generator/variant setup
 * (manifest.utilities.main.js) without any of its DOM work, which this never
 * runs: `new TailwindCompiler()` is never called here. */
function createNodeCompiler() {
    const instance = Object.create(TailwindCompiler.prototype);
    instance.options = { rootSelector: ':root', themeSelector: '@theme' };
    instance.regexPatterns = {
        root: new RegExp(`${instance.options.rootSelector}\\s*{([^}]*)}`, 'g'),
        theme: new RegExp(`${instance.options.themeSelector}\\s*{([^}]*)}`, 'g'),
        variable: /--([\w-]+):\s*([^;]+);/g,
        tailwindPrefix: /^(color|font|text|font-weight|tracking|leading|breakpoint|container|spacing|radius|shadow|inset-shadow|drop-shadow|blur|perspective|aspect|ease|animate|border-width|border-style|outline|outline-width|outline-style|ring|ring-offset|divide|accent|caret|decoration|placeholder|selection|scrollbar)-/
    };
    instance.utilityGenerators = createUtilityGenerators();
    instance.variants = createVariants();
    instance.variantGroups = createVariantGroups();
    instance.classCache = new Map();
    instance.customUtilities = new Map();
    return instance;
}

// --- Tailwind engine pass -------------------------------------------------
// Bakes the plain Tailwind-style utilities (flex, gap-2, rounded-full,
// w-[37px], md:, hover:, …) that the runtime's bundled Tailwind engine
// (lib/manifest.tailwind.js — a Tailwind v4 "Play CDN" browser build) would
// otherwise generate live. Uses the real `tailwindcss` package's compile()/
// build() — the same core compiler that browser build wraps, not a fork —
// which is pure JS with no native binding and no DOM requirement.
//
// The browser engine reads only `<style type="text/tailwindcss">` tags
// (default: `@import "tailwindcss";` plus whatever such tags are on the
// page) and derives its candidates from `document.querySelectorAll("[class]")`
// — it does not see Manifest's theme vars, so this mirrors that: no bridging
// of `themeCss` into Tailwind's `@theme`. The custom variants below mirror
// injectTailwindVariants() in manifest.utilities.init.js — keep both in sync.
const TAILWIND_CUSTOM_VARIANTS = [
    '@custom-variant touch (@media (pointer: coarse));',
    '@custom-variant cursor (@media (pointer: fine) and (hover: hover));',
    '@custom-variant pointer (@media (any-pointer: fine));',
    '@custom-variant mac (&:where([data-os="macos"] *));',
    '@custom-variant windows (&:where([data-os="windows"] *));',
    '@custom-variant linux (&:where([data-os="linux"] *));',
    '@custom-variant ios (&:where([data-os="ios"] *));',
    '@custom-variant android (&:where([data-os="android"] *));',
    '@custom-variant apple (&:where([data-os="macos"] *, [data-os="ios"] *));',
    '@custom-variant online (&:where([data-online="true"] *));',
    '@custom-variant offline (&:where([data-online="false"] *));',
    '@custom-variant standalone (&:where([data-standalone] *));',
    '@custom-variant native (&:where([data-native] *));',
    '@custom-variant web (&:where(html:not([data-native]) *));'
].join('\n');

/** Balanced-brace extraction of a top-level `@layer <name> { ... }` body —
 * the compiled CSS nests braces (media queries, `&:hover`), so a regex can't
 * safely find the matching close brace. Returns '' when the layer is absent. */
function extractLayerBody(css, layerName) {
    const marker = `@layer ${layerName} {`;
    const start = css.indexOf(marker);
    if (start === -1) return '';
    let depth = 1;
    let i = start + marker.length;
    const bodyStart = i;
    for (; i < css.length && depth > 0; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') depth--;
    }
    return css.slice(bodyStart, i - 1).trim();
}

let _tailwindEnginePromise = null;
/** Lazily loads tailwindcss's compile() plus its theme.css/utilities.css text
 * — the expensive, reusable I/O (dynamic import, two fs reads). Cached
 * across calls; resolves to null (fail open) when the package or Node's
 * fs/require aren't available in this runtime (e.g. a bare Workers isolate),
 * so callers degrade to Manifest-only utilities rather than throwing.
 *
 * Deliberately skips tailwindcss/preflight.css: the browser engine's own
 * default `@import "tailwindcss"` — see `jo`/`Io` in lib/manifest.tailwind.js
 * — wires up only theme.css and utilities.css and leaves preflight empty, so
 * matching it means never importing preflight here either (Manifest ships
 * its own reset; the runtime never asks Tailwind for one). */
function loadTailwindEngine() {
    if (_tailwindEnginePromise) return _tailwindEnginePromise;
    _tailwindEnginePromise = (async () => {
        try {
            const { compile } = await import('tailwindcss');
            const fs = await import('node:fs');
            const path = await import('node:path');
            const { createRequire } = await import('node:module');
            const req = createRequire(import.meta.url);
            const themePath = req.resolve('tailwindcss/theme.css');
            const utilitiesPath = req.resolve('tailwindcss/utilities.css');
            const themeCss = fs.readFileSync(themePath, 'utf8');
            const utilitiesCss = fs.readFileSync(utilitiesPath, 'utf8');
            const base = path.dirname(themePath);
            return { compile, base, themeCss, utilitiesCss };
        } catch (e) {
            return null;
        }
    })();
    return _tailwindEnginePromise;
}

/** Runs the real Tailwind engine over exactly `classes`, returning its
 * (tree-shaken, used-only) `theme` and `utilities` layer bodies as a single
 * CSS chunk. Returns '' when Tailwind can't be loaded here, or produced no
 * utility rules for these classes (the default theme's font/spacing tokens
 * would otherwise show up even for a class list with no real Tailwind match
 * — e.g. Manifest's own `.row`/`.col` — since they're always defined; only
 * emit the theme chunk alongside actual utility output).
 *
 * A fresh compiler is built per call (~a few ms — see loadTailwindEngine for
 * the cached, reusable part): tailwindcss's compiler.build() is an
 * incremental/watch-mode API that accumulates every candidate it has ever
 * seen, so reusing one compiler across calls with different class lists
 * would leak earlier calls' classes into later output — the same reason the
 * browser engine tracks its own "already seen" set (see the header comment)
 * before calling build(). */
async function compileTailwindPass(classes) {
    if (!classes.length) return '';
    const engine = await loadTailwindEngine();
    if (!engine) return '';
    try {
        const { compile, base, themeCss, utilitiesCss } = engine;
        const input = `@layer theme, base, components, utilities;\n@import "tailwindcss/theme" layer(theme);\n@import "tailwindcss/utilities" layer(utilities);\n${TAILWIND_CUSTOM_VARIANTS}\n`;
        const compiler = await compile(input, {
            base,
            loadStylesheet: async (id) => {
                if (id === 'tailwindcss/theme') return { base, content: themeCss };
                if (id === 'tailwindcss/utilities') return { base, content: utilitiesCss };
                throw new Error(`manifest utilities: cannot load "${id}" for Tailwind bake`);
            },
            loadModule: async () => { throw new Error('manifest utilities: Tailwind plugins unsupported in bake'); }
        });
        const css = compiler.build(classes);
        const utilities = extractLayerBody(css, 'utilities');
        if (!utilities) return '';
        const theme = extractLayerBody(css, 'theme');
        const parts = [];
        if (theme) parts.push(`@layer theme {\n${theme}\n}`);
        parts.push(`@layer utilities {\n${utilities}\n}`);
        return parts.join('\n\n');
    } catch (e) {
        return '';
    }
}

/**
 * Compile the utility CSS the browser plugin (Manifest's own generators) plus
 * the framework's bundled Tailwind engine would together produce for exactly
 * `classes`. Manifest side: variants, theme-variable-driven utilities
 * (generateUtilitiesFromVars) and custom utilities (generateCustomUtilities)
 * discovered in `themeCss`/`baseCss`. Tailwind side: whatever real Tailwind
 * utilities (`flex`, `gap-2`, `rounded-full`, arbitrary values like
 * `w-[37px]`, and their variants) the class list resolves to, via the actual
 * `tailwindcss` compiler (see compileTailwindPass above) — not a fork.
 * Deterministic for a given (classes, themeCss, baseCss) triple.
 *
 * `baseCss` should include the framework's own utility CSS (lib/manifest.css)
 * whenever the caller isn't already loading it: the browser plugin's compile()
 * finds it for free via discoverCssFiles() scanning the page's own
 * stylesheets, so generateCustomUtilities() recognises Manifest's semantic
 * utilities (.row, .col, .center, …) and bakes variants like `md:row` or
 * `hover:col-wrap`. Without it those variants are silently skipped here —
 * scripts/utilities-static.mjs loads it automatically for this reason.
 *
 * @param {{classes?: string[], themeCss?: string, baseCss?: string}} options
 * @returns {Promise<string>}
 */
export async function compileUtilities({ classes = [], themeCss = '', baseCss = '' } = {}) {
    const compiler = createNodeCompiler();
    const cssText = [baseCss, themeCss].filter(Boolean).join('\n');
    const uniqueClasses = Array.from(new Set(classes));

    const discovered = compiler.extractCustomUtilities(cssText);
    for (const [name, value] of discovered) compiler.customUtilities.set(name, value);

    const usedData = { classes: uniqueClasses, variableSuffixes: [] };

    const varUtilities = compiler.generateUtilitiesFromVars(cssText, usedData);
    const customUtilities = compiler.generateCustomUtilities(usedData);

    let allUtilities = [varUtilities, customUtilities].filter(Boolean).join('\n\n');
    allUtilities = compiler.sortUtilities(allUtilities);

    const manifestLayer = allUtilities ? `@layer utilities {\n${allUtilities}\n}` : '';
    const tailwindLayer = await compileTailwindPass(uniqueClasses);

    return [manifestLayer, tailwindLayer].filter(Boolean).join('\n\n');
}

// `class:token=` (per-class conditional binding) and the `:class="..."`
// shorthand aren't matched by extractClassesFromHTML's `x-(data|bind:class|class)=`
// regex (no `x-` prefix), so pick those up here too — cheap regex pass, not a
// JS/expression parser, so only literal-looking quoted tokens are kept.
const CLASS_TOKEN_BINDING_RE = /\bclass:([a-zA-Z0-9_-]+(?:\\.[a-zA-Z0-9_-]+)*)\s*=/g;
// Backreference to the opening quote so a nested quote char (`:class="'a b'"`)
// doesn't truncate the match early.
const SHORTHAND_CLASS_BINDING_RE = /\B:class=(["'])((?:(?!\1)[\s\S])*)\1/g;

/**
 * Scan HTML for utility class tokens using the same extraction the browser
 * plugin uses (extractClassesFromHTML), plus `class:`/`:class` static tokens.
 * Skips `x-`/`$` tokens. Returns a sorted, deduplicated array.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function scanClasses(html) {
    const compiler = createNodeCompiler();
    const set = new Set();
    compiler.extractClassesFromHTML(html, set);

    let m;
    CLASS_TOKEN_BINDING_RE.lastIndex = 0;
    while ((m = CLASS_TOKEN_BINDING_RE.exec(html)) !== null) {
        const cls = m[1].replace(/\\(.)/g, '$1');
        if (cls && !cls.startsWith('x-') && !cls.startsWith('$')) set.add(cls);
    }

    SHORTHAND_CLASS_BINDING_RE.lastIndex = 0;
    while ((m = SHORTHAND_CLASS_BINDING_RE.exec(html)) !== null) {
        const content = m[2];
        const quoted = content.match(/['"`]([^'"`\s]+)['"`]/g);
        if (quoted) {
            for (const q of quoted) {
                const cls = q.replace(/['"`]/g, '');
                if (cls && !cls.startsWith('$') && !cls.startsWith('x-') && !cls.includes('(')) set.add(cls);
            }
        }
    }

    return Array.from(set).sort();
}
