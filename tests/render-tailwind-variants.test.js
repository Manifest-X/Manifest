import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    TAILWIND_CUSTOM_VARIANTS,
    TAILWIND_DARK_VARIANT,
    authorTailwindCss,
    buildTailwindCliInput,
    runTailwindCliForPrerender,
} from '../src/scripts/manifest.render.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoModules = join(repo, 'node_modules');
const hasCli = existsSync(join(repoModules, '@tailwindcss', 'cli'));

const AUTHOR_DARK = '@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));';
const shell = (head = '') => `<!DOCTYPE html><html><head>${head}
<script src="/manifest.min.js" data-tailwind></script></head>
<body><div class="dark:bg-black touch:px-4"></div></body></html>`;

describe('Tailwind CLI variants', () => {
    it('match injectTailwindVariants() in the live framework', () => {
        const src = readFileSync(join(repo, 'lib/manifest.utilities.js'), 'utf8');
        const live = [...src.matchAll(/'(@custom-variant [^']+)'/g)].map(m => m[1]);
        expect(live).toEqual([...TAILWIND_CUSTOM_VARIANTS, TAILWIND_DARK_VARIANT]);
    });

    it('adds the class-based dark variant by default', () => {
        const css = buildTailwindCliInput({ indexHtml: shell() });
        expect(css.startsWith('@import "tailwindcss";')).toBe(true);
        expect(css).toContain(TAILWIND_DARK_VARIANT);
        for (const v of TAILWIND_CUSTOM_VARIANTS) expect(css).toContain(v);
    });

    it('lets an author text/tailwindcss dark declaration win', () => {
        const html = shell(`<style type="text/tailwindcss">@theme { --color-x: red; }\n${AUTHOR_DARK}</style>`);
        const css = buildTailwindCliInput({ indexHtml: html });
        expect(css).toContain(AUTHOR_DARK);
        expect(css).not.toContain(TAILWIND_DARK_VARIANT);
    });

    it('honours block-form author dark declarations', () => {
        const block = '@custom-variant dark {\n  &:where(.night *) { @slot; }\n}';
        const css = buildTailwindCliInput({ indexHtml: shell(`<style type='text/tailwindcss'>${block}</style>`) });
        expect(css).toContain(block);
        expect(css).not.toContain(TAILWIND_DARK_VARIANT);
    });

    it('feeds every author block in document order, before Manifest variants', () => {
        const html = shell(`<style type="text/tailwindcss" id="a">@theme { --color-brand: #f00; }</style>
<style>.plain { color: red; }</style><style type=text/tailwindcss>@utility foo { letter-spacing: 3px; }</style>`);
        expect(authorTailwindCss(html)).toBe('@theme { --color-brand: #f00; }\n@utility foo { letter-spacing: 3px; }');
        const css = buildTailwindCliInput({ indexHtml: html });
        expect(css).not.toContain('.plain');
        const at = (s) => css.indexOf(s);
        expect(at('@import "tailwindcss";')).toBe(0);
        expect(at('@theme')).toBeLessThan(at('@utility foo'));
        expect(at('@utility foo')).toBeLessThan(at(TAILWIND_CUSTOM_VARIANTS[0]));
    });

    it('strips comments without touching strings or globs', () => {
        const html = shell('<style type="text/tailwindcss">@source "./x/*.js"; .a { content: "/*"; } /* note */ .b { content: \'*/\'; }</style>');
        expect(authorTailwindCss(html)).toBe('@source "./x/*.js"; .a { content: "/*"; }  .b { content: \'*/\'; }');
    });

    it('ignores blocks in HTML comments, templates and data-type attributes', () => {
        const html = shell(`<!-- <style type="text/tailwindcss">@plugin "nope";</style> -->
<template><style type="text/tailwindcss">@plugin "tpl";</style></template>
<style data-type="text/tailwindcss">@plugin "data";</style>
<style type="text/tailwindcss">@theme { --color-ok: #0f0; }</style>`);
        expect(authorTailwindCss(html)).toBe('@theme { --color-ok: #0f0; }');
    });

    it('maps the live engine\'s relative Tailwind imports', () => {
        const html = shell('<style type="text/tailwindcss">@import "./theme.css"; @import \'./utilities.css\';</style>');
        expect(authorTailwindCss(html)).toBe('@import "tailwindcss/theme.css"; @import \'tailwindcss/utilities.css\';');
    });

    it('lets an author @import replace the default, as the live engine does', () => {
        const html = shell('<style type="text/tailwindcss">@import "tailwindcss/utilities";</style>');
        const css = buildTailwindCliInput({ indexHtml: html });
        expect(css).not.toContain('@import "tailwindcss";');
        expect(css.startsWith('@import "tailwindcss/utilities";')).toBe(true);
    });

    it('drops author @imports when tailwindInput owns the entry', () => {
        const html = shell('<style type="text/tailwindcss">@import "tailwindcss";\n@theme { --color-brand: #f00; }</style>');
        const css = buildTailwindCliInput({ importPath: './app.css', indexHtml: html });
        expect(css.match(/@import/g)).toEqual(['@import']);
        expect(css).toContain('--color-brand');
    });

    it('ignores commented-out author declarations', () => {
        const html = shell(`<style type="text/tailwindcss">/* ${AUTHOR_DARK} */</style>`);
        expect(authorTailwindCss(html)).toBe('');
        expect(buildTailwindCliInput({ indexHtml: html })).toContain(TAILWIND_DARK_VARIANT);
        const css = buildTailwindCliInput({ importPath: './app.css', inputCss: `@import "tailwindcss";\n/*\n${AUTHOR_DARK}\n*/` });
        expect(css).toContain(TAILWIND_DARK_VARIANT);
    });

    it('leaves dark to a tailwindInput file that declares it', () => {
        const css = buildTailwindCliInput({ importPath: './app.css', inputCss: `@import "tailwindcss";\n${AUTHOR_DARK}` });
        expect(css.startsWith('@import "./app.css";')).toBe(true);
        expect(css).not.toContain('@custom-variant dark');
    });
});

it('has @tailwindcss/cli installed for the real-CLI tests (devDependency; run npm ci)', () => {
    expect(hasCli).toBe(true);
});

describe.skipIf(!hasCli)('runTailwindCliForPrerender (real CLI)', () => {
    let tmp;
    beforeAll(() => { tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mnfst-render-tw-'))); });
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    const build = (name, head, pre) => {
        const site = join(tmp, name);
        const out = join(site, 'dist');
        mkdirSync(out, { recursive: true });
        writeFileSync(join(site, 'index.html'), shell(head));
        if (pre?.files) for (const [f, c] of Object.entries(pre.files)) writeFileSync(join(site, f), c);
        expect(runTailwindCliForPrerender(site, out, pre, [repoModules])).toBe(true);
        expect(readdirSync(site).filter(f => f.startsWith('.mnfst-prerender-tailwind-input'))).toEqual([]);
        return readFileSync(join(out, 'prerender.tailwind.css'), 'utf8');
    };
    const rule = (css, cls) => css.slice(css.indexOf(cls), css.indexOf('}', css.indexOf(cls)));

    it('compiles dark: against .dark, not prefers-color-scheme', () => {
        const css = build('default');
        const dark = rule(css, '.dark\\:bg-black');
        expect(dark).toContain(':where(.dark, .dark *)');
        expect(dark).not.toContain('prefers-color-scheme');
        expect(rule(css, '.touch\\:px-4')).toContain('pointer: coarse');
    }, 30000);

    it('honours an author dark override in index.html', () => {
        const css = build('author', `<style type="text/tailwindcss">${AUTHOR_DARK}</style>`);
        const dark = rule(css, '.dark\\:bg-black');
        expect(dark).toContain('[data-theme=dark]');
        expect(dark).not.toContain('.dark *');
    }, 30000);

    it('uses Manifest dark when author overrides are commented out', () => {
        const css = build('commented', `<style type="text/tailwindcss">/* ${AUTHOR_DARK} */</style>`, {
            tailwindInput: 'app.css',
            files: { 'app.css': `@import "tailwindcss";\n/* ${AUTHOR_DARK} */\n` },
        });
        const dark = rule(css, '.dark\\:bg-black');
        expect(dark).toContain(':where(.dark, .dark *)');
        expect(dark).not.toContain('[data-theme=dark]');
    }, 30000);

    it('compiles the author theme, utilities and variants from index.html', () => {
        const site = join(tmp, 'theme');
        const out = join(site, 'dist');
        mkdirSync(out, { recursive: true });
        writeFileSync(join(site, 'index.html'), `<!DOCTYPE html><html><head>
<style type="text/tailwindcss">@theme { --color-brand: #f00; }
@utility foo { letter-spacing: 3px; }
@custom-variant hocus (&:hover, &:focus);
@custom-variant touch (&:where(.author-touch *));</style>
<script src="/manifest.min.js" data-tailwind></script></head>
<body><div class="bg-brand foo hocus:underline touch:px-4"></div></body></html>`);
        expect(runTailwindCliForPrerender(site, out, {}, [repoModules])).toBe(true);
        const css = readFileSync(join(out, 'prerender.tailwind.css'), 'utf8');
        expect(css).toContain('--color-brand: #f00');
        expect(rule(css, '.bg-brand')).toContain('var(--color-brand)');
        expect(rule(css, '.foo')).toContain('letter-spacing: 3px');
        expect(rule(css, '.hocus\\:underline')).toContain('&:hover');
        expect(rule(css, '.touch\\:px-4')).toContain('pointer: coarse');
        expect(rule(css, '.touch\\:px-4')).not.toContain('author-touch');
    }, 30000);

    it('keeps @source globs intact next to comments', () => {
        const site = join(tmp, 'source');
        const out = join(site, 'dist');
        mkdirSync(join(site, 'x'), { recursive: true });
        mkdirSync(out, { recursive: true });
        writeFileSync(join(site, 'x', 'a.js'), "el.className = 'text-brand';");
        writeFileSync(join(site, 'index.html'), shell(`<style type="text/tailwindcss">@source "./x/*.js";
@theme { --color-brand: #f00; }
.q::before { content: "/*"; }
/* trailing comment */</style>`));
        expect(runTailwindCliForPrerender(site, out, {}, [repoModules])).toBe(true);
        const css = readFileSync(join(out, 'prerender.tailwind.css'), 'utf8');
        expect(rule(css, '.text-brand')).toContain('var(--color-brand)');
        expect(css).toContain('content: "/*"');
    }, 30000);

    it('resolves the live engine\'s relative Tailwind imports', () => {
        const css = build('virtual', '<style type="text/tailwindcss">@import "./theme.css"; @import "./utilities.css";</style>');
        expect(rule(css, '.touch\\:px-4')).toContain('pointer: coarse');
    }, 30000);

    it('honours an author dark override in tailwindInput', () => {
        const css = build('input', '', {
            tailwindInput: 'app.css',
            files: { 'app.css': `@import "tailwindcss";\n${AUTHOR_DARK}\n` },
        });
        const dark = rule(css, '.dark\\:bg-black');
        expect(dark).toContain('[data-theme=dark]');
        expect(dark).not.toContain('.dark *');
        expect(rule(css, '.touch\\:px-4')).toContain('pointer: coarse');
    }, 30000);
});
