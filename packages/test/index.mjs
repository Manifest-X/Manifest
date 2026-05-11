// mnfst-test: component-level testing harness for Manifest.
//
// Boots a Manifest project (or a single component) inside happy-dom, loads
// Alpine and the requested Manifest plugins, and returns query + interaction
// helpers. Designed to run inside Vitest.
//
// Typical use:
//
//   import { mountManifest } from 'mnfst-test';
//
//   it('cart adds items', async () => {
//     const { getByText, click, $ } = await mountManifest({
//       html: '<div x-data="cart()" x-text="total"></div>',
//       data: { products: [{ id: 'sku-1', price: 10 }] }
//     });
//     // ... assertions, interactions
//   });

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let happyDom = null;
async function loadHappyDom() {
    if (happyDom) return happyDom;
    try {
        happyDom = await import('happy-dom');
        return happyDom;
    } catch (e) {
        throw new Error([
            "happy-dom is required by mnfst-test but is not installed.",
            "Install it in your project as a devDependency:",
            "",
            "  npm install -D happy-dom vitest mnfst-test",
            "",
            `Underlying error: ${e.message}`
        ].join('\n'));
    }
}

let alpineSource = null;
async function loadAlpineSource() {
    if (alpineSource) return alpineSource;
    // Prefer a local alpinejs install; fall back to fetching the CDN bundle.
    try {
        const require = (await import('node:module')).createRequire(import.meta.url);
        const alpinePath = require.resolve('alpinejs/dist/cdn.min.js');
        alpineSource = readFileSync(alpinePath, 'utf8');
        return alpineSource;
    } catch { /* fall through to CDN */ }
    const res = await fetch('https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js');
    if (!res.ok) {
        throw new Error([
            "Could not load Alpine.js. Either install it locally:",
            "  npm install -D alpinejs",
            "Or ensure your test environment can reach the jsDelivr CDN.",
            "",
            `CDN response: ${res.status}`
        ].join('\n'));
    }
    alpineSource = await res.text();
    return alpineSource;
}

/**
 * Mount a snippet of HTML (or a full project page) in happy-dom with Alpine
 * and the requested Manifest plugins active.
 *
 * @param {object} opts
 * @param {string} [opts.html]      HTML body to mount. Required unless `page` is set.
 * @param {string} [opts.page]      Path to an HTML file to load as the document.
 * @param {object} [opts.manifest]  In-memory manifest.json. Defaults to {}.
 * @param {object} [opts.data]      In-memory data sources. Each key becomes $x.<key>.
 * @param {string[]} [opts.plugins] Manifest plugin file paths to evaluate after Alpine loads.
 * @param {number}  [opts.settle]   Milliseconds to wait after mount for Alpine to render. Default 50.
 *
 * @returns {Promise<MountedManifest>}
 */
export async function mountManifest(opts = {}) {
    const { Window } = await loadHappyDom();
    const window = new Window({ url: 'http://localhost/' });
    const { document } = window;

    const manifest = opts.manifest || {};
    const inMemoryData = opts.data || {};

    // Stub fetch so that data-source loaders see in-memory data.
    window.fetch = async (url) => {
        const u = String(url);
        // Resolve manifest.json fetches to the provided manifest.
        if (u.endsWith('/manifest.json') || u === '/manifest.json' || u.endsWith('manifest.json')) {
            return mockResponse(manifest);
        }
        // Resolve in-memory data by trailing path match.
        for (const [key, value] of Object.entries(inMemoryData)) {
            if (u.endsWith(`/${key}`) || u.endsWith(`/${key}.json`) || u.endsWith(`/${key}.csv`)) {
                return mockResponse(value);
            }
        }
        return new window.Response('', { status: 404 });
    };

    // Add a manifest <link> so plugins resolve to our stub URL.
    const manifestLink = document.createElement('link');
    manifestLink.setAttribute('rel', 'manifest');
    manifestLink.setAttribute('href', '/manifest.json');
    document.head.appendChild(manifestLink);

    if (opts.html) {
        document.body.innerHTML = opts.html;
    } else if (opts.page) {
        const full = resolve(opts.page);
        document.documentElement.innerHTML = readFileSync(full, 'utf8');
    } else {
        throw new Error('mountManifest: provide either `html` or `page`');
    }

    // Load Alpine.
    const alpine = await loadAlpineSource();
    runScript(window, alpine);

    // Load any requested Manifest plugins.
    if (Array.isArray(opts.plugins)) {
        for (const p of opts.plugins) {
            try {
                runScript(window, readFileSync(p, 'utf8'));
            } catch (e) {
                throw new Error(`mountManifest: failed to load plugin "${p}": ${e.message}`);
            }
        }
    }

    // Trigger Alpine's auto-init (it uses DOMContentLoaded).
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
    await new Promise((r) => setTimeout(r, opts.settle != null ? opts.settle : 50));

    return makeApi(window);
}

function mockResponse(value) {
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    return {
        ok: true,
        status: 200,
        json: async () => (typeof value === 'string' ? JSON.parse(value) : value),
        text: async () => body,
        headers: new Map([['content-type', typeof value === 'string' ? 'text/plain' : 'application/json']])
    };
}

function runScript(window, source) {
    // happy-dom provides a true Function constructor; eval source in window scope.
    const fn = new window.Function('window', 'document', source);
    fn.call(window, window, window.document);
}

function makeApi(window) {
    const { document } = window;
    return {
        window,
        document,
        body: document.body,
        $: (sel) => document.querySelector(sel),
        $$: (sel) => Array.from(document.querySelectorAll(sel)),
        getByText(text) {
            const all = document.querySelectorAll('*');
            for (const el of all) {
                if (el.textContent?.trim() === text) return el;
            }
            return null;
        },
        getByRole(role) {
            return document.querySelector(`[role="${role}"]`);
        },
        getById(id) { return document.getElementById(id); },
        click(target) {
            const el = typeof target === 'string' ? document.querySelector(target) : target;
            if (!el) throw new Error(`click: no element matched ${target}`);
            el.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
        },
        type(target, value) {
            const el = typeof target === 'string' ? document.querySelector(target) : target;
            if (!el) throw new Error(`type: no element matched ${target}`);
            el.value = value;
            el.dispatchEvent(new window.Event('input', { bubbles: true }));
            el.dispatchEvent(new window.Event('change', { bubbles: true }));
        },
        async tick(ms = 16) {
            await new Promise((r) => setTimeout(r, ms));
        },
        async unmount() {
            await window.happyDOM?.cancelAsync();
            window.close?.();
        }
    };
}

/**
 * @typedef {object} MountedManifest
 * @property {Window}   window
 * @property {Document} document
 * @property {HTMLElement} body
 * @property {(sel: string) => Element | null} $
 * @property {(sel: string) => Element[]} $$
 * @property {(text: string) => Element | null} getByText
 * @property {(role: string) => Element | null} getByRole
 * @property {(id: string) => HTMLElement | null} getById
 * @property {(target: string | Element) => void} click
 * @property {(target: string | Element, value: string) => void} type
 * @property {(ms?: number) => Promise<void>} tick
 * @property {() => Promise<void>} unmount
 */
