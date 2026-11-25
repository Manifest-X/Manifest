// Tailwind engine output cache: the loader replays it (manifest.js replayTailwindCache);
// this side watches for anything it doesn't cover and records the engine's output.

const TAILWIND_CACHE_IGNORED = new Set(['dark', 'light', 'window-resizing']);
const TAILWIND_CACHE_MAX_TOKENS = 6000;
const TAILWIND_CACHE_MAX_CSS = 512 * 1024;
const TAILWIND_CACHE_SAVE_DELAY = 1000;

function tailwindBlocks() {
    return Array.from(document.querySelectorAll('style[type="text/tailwindcss"]'), s => s.textContent);
}

function sameTailwindBlocks(a, b) {
    if (a.length !== b.length) return false;
    const x = a.slice().sort(), y = b.slice().sort();
    return x.every((v, i) => v === y[i]);
}

function isTailwindEngineStyle(el) {
    return el.localName === 'style' && !el.id && !el.hasAttribute('data-tailwind-cache') &&
        !el.hasAttribute('data-mnfst-utilities') && (el.textContent || '').startsWith('/*! tailwindcss');
}

function findTailwindEngineStyle() {
    for (const s of document.querySelectorAll('style')) if (isTailwindEngineStyle(s)) return s;
    return null;
}

function elementClassTokens(el, out) {
    const cls = el.getAttribute && el.getAttribute('class');
    if (!cls) return out;
    for (const t of cls.split(/\s+/)) if (t && !TAILWIND_CACHE_IGNORED.has(t)) out.push(t);
    return out;
}

function documentClassTokens(into) {
    for (const el of document.querySelectorAll('[class]')) {
        if (el.hasAttribute('data-tailwind-seed')) continue;
        for (const t of elementClassTokens(el, [])) into.add(t);
    }
    return into;
}

function shippedUtilitiesSheetPresent() {
    try {
        return !!document.querySelector('[data-mnfst-utilities], link[href*="prerender.tailwind.css"], link[href*="prerender.utilities.css"]');
    } catch (e) {
        return true;
    }
}

function isTailwindBlock(node) {
    return node && node.nodeType === 1 && node.localName === 'style' && node.getAttribute('type') === 'text/tailwindcss';
}

// Replay mode: cached CSS is in place and the engine was not fetched
function watchCachedTailwind(state) {
    const rec = state.record;
    const known = new Set(rec.tokens);
    const blockObservers = [];
    let loading = false;
    let observer = null;
    let swap = null;

    const stop = () => {
        if (observer) observer.disconnect();
        blockObservers.forEach(o => o.disconnect());
    };
    state.stop = () => { stop(); if (swap) swap.disconnect(); };

    const load = (reason, unseen) => {
        if (loading) return;
        loading = true;
        stop();
        state.reason = reason;
        // Same config: seed the engine with the cached tokens so its output covers the union
        let seed = null;
        if (reason === 'unseen' && rec.tokens.length < TAILWIND_CACHE_MAX_TOKENS && rec.css.length < TAILWIND_CACHE_MAX_CSS / 2) {
            seed = document.createElement('div');
            seed.hidden = true;
            seed.setAttribute('aria-hidden', 'true');
            seed.setAttribute('data-tailwind-seed', '');
            seed.setAttribute('class', rec.tokens.join(' '));
            (document.body || document.documentElement).appendChild(seed);
        }
        const handoff = () => {
            if (state.style) state.style.remove();
            if (seed) seed.remove();
            state.style = null;
            recordTailwindEngine(state, seed ? rec.tokens : null);
            window.dispatchEvent(new CustomEvent('manifest:tailwind-cache', { detail: { engineLoaded: true, reason, unseen: unseen || [] } }));
        };
        const p = state.load || (state.load = window.Manifest.loadTailwind());
        p.then(() => {
            if (findTailwindEngineStyle()) return handoff();
            // Swap only once the engine's own sheet has rules: no unstyled frame
            swap = new MutationObserver(() => {
                if (!findTailwindEngineStyle()) return;
                swap.disconnect();
                handoff();
            });
            swap.observe(document.head, { childList: true, subtree: true, characterData: true });
        }).catch(() => {
            if (seed) seed.remove();
            state.load = null;
            loading = false;
            arm();
        });
    };

    const checkBlocks = (exact) => {
        const now = tailwindBlocks();
        const ok = exact ? sameTailwindBlocks(now, rec.blocks) : now.every(b => rec.blocks.includes(b));
        if (!ok) load('config');
        return ok;
    };

    const watchBlock = (el) => {
        const o = new MutationObserver(() => checkBlocks(true));
        o.observe(el, { characterData: true, childList: true, subtree: true });
        blockObservers.push(o);
    };

    const checkTokens = (tokens) => {
        const unseen = tokens.filter(t => !known.has(t));
        if (unseen.length) load('unseen', unseen);
    };

    const arm = () => {
        observer = new MutationObserver((mutations) => {
            if (loading) return;
            const tokens = [];
            let blocks = false;
            for (const m of mutations) {
                if (m.type === 'attributes') {
                    if (m.attributeName === 'type' && (isTailwindBlock(m.target) || m.target.localName === 'style')) blocks = true;
                    else if (m.attributeName === 'class' && !m.target.hasAttribute('data-tailwind-seed')) elementClassTokens(m.target, tokens);
                    continue;
                }
                if (isTailwindBlock(m.target)) blocks = true;
                for (const n of m.removedNodes) if (isTailwindBlock(n)) blocks = true;
                for (const n of m.addedNodes) {
                    if (n.nodeType !== 1 || n.hasAttribute('data-tailwind-seed')) continue;
                    if (isTailwindBlock(n)) { blocks = true; watchBlock(n); }
                    elementClassTokens(n, tokens);
                    if (n.firstElementChild) for (const d of n.querySelectorAll('[class]')) elementClassTokens(d, tokens);
                    if (n.firstElementChild) for (const s of n.querySelectorAll('style[type="text/tailwindcss"]')) { blocks = true; watchBlock(s); }
                }
            }
            if (blocks && !checkBlocks(document.readyState !== 'loading')) return;
            if (tokens.length) checkTokens(tokens);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'type'] });
        document.querySelectorAll('style[type="text/tailwindcss"]').forEach(watchBlock);
    };

    arm();
    if (!checkBlocks(false)) return;
    checkTokens(Array.from(documentClassTokens(new Set())));
    const onReady = () => {
        if (loading) return;
        // Every parsed block is in: the set must match exactly; a shipped sheet means the eager path
        if (shippedUtilitiesSheetPresent()) return load('shipped');
        if (checkBlocks(true)) checkTokens(Array.from(documentClassTokens(new Set())));
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
    else onReady();
}

function saveTailwindCache(state, record) {
    const json = JSON.stringify(record);
    for (let i = 0; i < 2; i++) {
        try {
            localStorage.setItem(state.key, json);
            return true;
        } catch (e) {
            try { localStorage.removeItem(state.key); } catch (_) { return false; }
        }
    }
    return false;
}

// Engine mode: record its output once it goes quiet
function recordTailwindEngine(state, seedTokens) {
    if (state.recording) return;
    state.recording = true;
    const carried = seedTokens ? new Set(seedTokens) : new Set();
    let timer = null;
    const save = () => {
        timer = null;
        if (shippedUtilitiesSheetPresent()) return;
        const engine = findTailwindEngineStyle();
        if (!engine) return;
        const css = engine.textContent;
        if (css.length > TAILWIND_CACHE_MAX_CSS) {
            try { localStorage.removeItem(state.key); } catch (_) { }
            return;
        }
        const tokens = documentClassTokens(new Set(carried));
        if (tokens.size > TAILWIND_CACHE_MAX_TOKENS) {
            try { localStorage.removeItem(state.key); } catch (_) { }
            return;
        }
        const record = { v: state.v, t: Date.now(), blocks: tailwindBlocks(), tokens: Array.from(tokens), css };
        if (saveTailwindCache(state, record)) state.saved = record;
    };
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(save, TAILWIND_CACHE_SAVE_DELAY);
    };
    const headObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            const el = m.target.nodeType === 1 ? m.target : m.target.parentNode;
            if (el && el.localName === 'style' && !el.id) return schedule();
            for (const n of m.addedNodes) if (n.localName === 'style') return schedule();
        }
    });
    headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
    state.stop = () => { headObserver.disconnect(); clearTimeout(timer); };
    schedule();
}

function armTailwindCache() {
    const state = window.__tailwindCache;
    if (!state || state.armed) return;
    state.armed = true;
    if (state.record && state.style && state.style.isConnected) watchCachedTailwind(state);
    else recordTailwindEngine(state, null);
}
