import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    TAILWIND_CUSTOM_VARIANTS,
    TAILWIND_DARK_VARIANT,
    authorTailwindDarkVariants,
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
        const src = readFileSync(join(repo, 'src/scripts/utilities/manifest.utilities.init.js'), 'utf8');
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
        expect(authorTailwindDarkVariants(html)).toEqual([AUTHOR_DARK]);
        const css = buildTailwindCliInput({ indexHtml: html });
        expect(css).toContain(AUTHOR_DARK);
        expect(css).not.toContain(TAILWIND_DARK_VARIANT);
    });

    it('extracts block-form author declarations', () => {
        const block = '@custom-variant dark {\n  &:where(.night *) { @slot; }\n}';
        expect(authorTailwindDarkVariants(shell(`<style type='text/tailwindcss'>${block}</style>`))).toEqual([block]);
    });

    it('ignores commented-out author declarations', () => {
        const html = shell(`<style type="text/tailwindcss">/* ${AUTHOR_DARK} */</style>`);
        expect(authorTailwindDarkVariants(html)).toEqual([]);
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
