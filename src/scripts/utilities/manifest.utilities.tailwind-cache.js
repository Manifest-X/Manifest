// Tailwind engine output cache: the loader replays it (manifest.js replayTailwindCache);
// this side watches for anything it doesn't cover and records the engine's output.

const TAILWIND_CACHE_IGNORED = new Set(['dark', 'light', 'window-resizing']);
const TAILWIND_CACHE_MAX_TOKENS = 6000;
const TAILWIND_CACHE_MAX_CSS = 128 * 1024;
const TAILWIND_CACHE_ENTRIES = 4;
const TAILWIND_CACHE_BUDGET = 640 * 1024;
const TAILWIND_CACHE_QUIET = 1000;
const TAILWIND_CACHE_MIN_INTERVAL = 10000;
const TAILWIND_CACHE_FEED_DELAY = 250;

function tailwindAuthorBlockTexts() {
    return Array.from(document.querySelectorAll('style[type="text/tailwindcss"]:not(#manifest-tailwind-variants)'), s => s.textContent);
}

function tailwindVariantsText() {
    const el = document.getElementById('manifest-tailwind-variants');
    return el ? el.textContent : null;
}

function sameTailwindSequence(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

function isTailwindEngineStyle(el) {
    return el.localName === 'style' && !el.id && !el.hasAttribute('data-tailwind-cache') &&
        !el.hasAttribute('data-mnfst-utilities') && (el.textContent || '').startsWith('/*! tailwindcss');
}

function findTailwindEngineStyle() {
    for (const s of document.querySelectorAll('style')) if (isTailwindEngineStyle(s)) return s;
    return null;
}

function addClassTokens(value, into) {
    if (!value) return into;
    for (const t of value.split(/\s+/)) if (t && !TAILWIND_CACHE_IGNORED.has(t)) into.add(t);
    return into;
}

function documentClassTokens(into) {
    for (const el of document.querySelectorAll('[class]')) {
        if (!el.hasAttribute('data-tailwind-seed')) addClassTokens(el.getAttribute('class'), into);
    }
    return into;
}

// Literal strings and object keys of an Alpine :class expression
const TAILWIND_LITERAL_TOKEN = /^[^\s"'`{}();,]+$/;
function literalClassTokens(expr, into) {
    const strings = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = strings.exec(expr)) !== null) {
        if (m[2].includes('${')) continue;
        for (const t of m[2].split(/\s+/)) if (t && TAILWIND_LITERAL_TOKEN.test(t) && !TAILWIND_CACHE_IGNORED.has(t)) into.add(t);
    }
    const keys = /[{,]\s*([A-Za-z_][\w-]*)\s*:/g;
    while ((m = keys.exec(expr)) !== null) into.add(m[1]);
    return into;
}

// Class tokens a later visit may need: the document, <template> contents, x-transition and literal :class strings
function staticClassTokens(into) {
    const visit = (root) => {
        for (const el of root.querySelectorAll('*')) {
            if (el.hasAttribute('data-tailwind-seed')) continue;
            for (const a of el.attributes) {
                const n = a.name;
                if (n === 'class' || n.startsWith('x-transition:')) addClassTokens(a.value, into);
                else if (n === ':class' || n === 'x-bind:class') literalClassTokens(a.value, into);
            }
            if (el.localName === 'template' && el.content) visit(el.content);
        }
    };
    visit(document);
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

// Runs before the next frame is drawn (or soon, in a hidden tab)
function beforeNextFrame(fn) {
    if (document.hidden || typeof requestAnimationFrame !== 'function') setTimeout(fn, 0);
    else requestAnimationFrame(fn);
}

// Shows the engine tokens it hasn't seen, then calls done. The engine scans [class] anywhere in the
// document; an inert <template> in <head>, removed as soon as the engine's sheet updates (else before
// the next frame), is the least visible carrier.
function feedTailwindEngine(tokens, done) {
    const t = document.createElement('template');
    t.setAttribute('data-tailwind-seed', '');
    t.setAttribute('class', Array.from(tokens).join(' '));
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        o.disconnect();
        t.remove();
        done();
    };
    const o = new MutationObserver((mutations) => {
        for (const m of mutations) {
            const el = m.target.nodeType === 1 ? m.target : m.target.parentNode;
            if (el && isTailwindEngineStyle(el)) return finish();
        }
    });
    o.observe(document.head, { childList: true, subtree: true, characterData: true });
    document.head.appendChild(t);
    beforeNextFrame(finish);
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

    const handoff = (seed, reason, unseen) => {
        // Engine sheet takes the cached copy's place in the cascade
        const finish = () => {
            const engine = findTailwindEngineStyle();
            if (!engine) return false;
            if (state.style && state.style.isConnected) {
                state.style.parentNode.insertBefore(engine, state.style);
                state.style.remove();
            }
            state.style = null;
            recordTailwindEngine(state, seed);
            window.dispatchEvent(new CustomEvent('manifest:tailwind-cache', { detail: { engineLoaded: true, reason, unseen: unseen || [] } }));
            return true;
        };
        const swapWhenReady = () => beforeNextFrame(() => {
            if (finish()) return;
            swap = new MutationObserver(() => { if (finish()) swap.disconnect(); });
            swap.observe(document.head, { childList: true, subtree: true, characterData: true });
        });
        if (seed) feedTailwindEngine(seed, swapWhenReady);
        else swapWhenReady();
    };

    const load = (reason, unseen) => {
        if (loading) return;
        loading = true;
        stop();
        state.reason = reason;
        // Same blocks: seed the engine with the cached tokens so its output covers the union
        const seed = reason === 'unseen' ? rec.tokens : null;
        const p = state.load || (state.load = window.Manifest.loadTailwind());
        p.then(() => handoff(seed, reason, unseen)).catch(() => {
            state.load = null;
            loading = false;
            arm();
        });
    };

    const checkBlocks = () => {
        const variants = tailwindVariantsText();
        const ok = sameTailwindSequence(tailwindAuthorBlockTexts(), rec.blocks) &&
            (variants === null || rec.variants === undefined || variants === rec.variants);
        if (!ok) load('config');
        return ok;
    };

    const watchBlock = (el) => {
        const o = new MutationObserver(() => checkBlocks());
        o.observe(el, { characterData: true, childList: true, subtree: true });
        blockObservers.push(o);
    };

    const checkTokens = (tokens) => {
        const unseen = [];
        for (const t of tokens) if (!known.has(t)) unseen.push(t);
        if (unseen.length) load('unseen', unseen);
    };

    const arm = () => {
        observer = new MutationObserver((mutations) => {
            if (loading) return;
            const tokens = new Set();
            let blocks = false;
            for (const m of mutations) {
                if (m.type === 'attributes') {
                    if (m.attributeName === 'type') { if (m.target.localName === 'style') blocks = true; continue; }
                    if (m.target.hasAttribute('data-tailwind-seed')) continue;
                    // Old values catch classes that came and went within one task (x-transition)
                    addClassTokens(m.oldValue, tokens);
                    addClassTokens(m.target.getAttribute('class'), tokens);
                    continue;
                }
                if (isTailwindBlock(m.target)) blocks = true;
                for (const n of m.removedNodes) if (isTailwindBlock(n)) blocks = true;
                for (const n of m.addedNodes) {
                    if (n.nodeType !== 1 || n.hasAttribute('data-tailwind-seed')) continue;
                    if (isTailwindBlock(n)) { blocks = true; watchBlock(n); }
                    addClassTokens(n.getAttribute('class'), tokens);
                    if (n.firstElementChild) {
                        for (const d of n.querySelectorAll('[class]')) addClassTokens(d.getAttribute('class'), tokens);
                        for (const s of n.querySelectorAll('style[type="text/tailwindcss"]')) { blocks = true; watchBlock(s); }
                    }
                }
            }
            if (blocks && !checkBlocks()) return;
            if (tokens.size) checkTokens(tokens);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'type'] });
        document.querySelectorAll('style[type="text/tailwindcss"]').forEach(watchBlock);
    };

    arm();
    if (!checkBlocks()) return;
    checkTokens(documentClassTokens(new Set()));
    const onReady = () => {
        if (loading) return;
        // A shipped sheet means the eager path; blocks parsed in <body> must match too
        if (shippedUtilitiesSheetPresent()) return load('shipped');
        if (checkBlocks()) checkTokens(documentClassTokens(new Set()));
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
    else onReady();
}

function readTailwindCacheIndex(state) {
    try {
        const index = JSON.parse(localStorage.getItem(state.key) || 'null');
        if (index && Array.isArray(index.ids) && index.sizes && typeof index.sizes === 'object') return index;
    } catch (e) { /* rebuilt below */ }
    return { ids: [], sizes: {} };
}

// Bounded LRU: at most TAILWIND_CACHE_ENTRIES entries within TAILWIND_CACHE_BUDGET
function writeTailwindCache(state, record) {
    const id = state.idFor(record.blocks);
    const entryKey = `${state.key}:${id}`;
    try {
        const index = readTailwindCacheIndex(state);
        const drop = (old) => {
            index.ids = index.ids.filter(x => x !== old);
            delete index.sizes[old];
            localStorage.removeItem(`${state.key}:${old}`);
        };
        if (record.css.length > TAILWIND_CACHE_MAX_CSS || record.tokens.length > TAILWIND_CACHE_MAX_TOKENS) {
            drop(id);
            localStorage.setItem(state.key, JSON.stringify(index));
            return false;
        }
        const json = JSON.stringify(record);
        index.ids = [id, ...index.ids.filter(x => x !== id)];
        index.sizes[id] = json.length;
        const total = () => index.ids.reduce((n, x) => n + (index.sizes[x] || 0), 0);
        while (index.ids.length > 1 && (index.ids.length > TAILWIND_CACHE_ENTRIES || total() > TAILWIND_CACHE_BUDGET)) drop(index.ids[index.ids.length - 1]);
        for (;;) {
            try {
                localStorage.setItem(entryKey, json);
                localStorage.setItem(state.key, JSON.stringify(index));
                return true;
            } catch (e) {
                if (index.ids.length <= 1) {
                    drop(id);
                    localStorage.setItem(state.key, JSON.stringify(index));
                    return false;
                }
                drop(index.ids[index.ids.length - 1]);
            }
        }
    } catch (e) {
        return false;
    }
}

// Engine mode: record its output and every token it has been shown
function recordTailwindEngine(state, seedTokens) {
    if (state.recording) return;
    state.recording = true;
    const seen = documentClassTokens(new Set(seedTokens || []));
    const fed = new Set(seedTokens || []);
    let dirty = true;
    let saveTimer = null;
    let feedTimer = null;
    let lastSave = 0;
    let feeding = false;

    const write = (tokens) => {
        if (shippedUtilitiesSheetPresent()) return;
        const engine = findTailwindEngineStyle();
        if (!engine) return;
        dirty = false;
        lastSave = Date.now();
        const record = { v: state.v, t: lastSave, blocks: tailwindAuthorBlockTexts(), variants: tailwindVariantsText(), tokens: Array.from(tokens), css: engine.textContent };
        if (writeTailwindCache(state, record)) state.saved = record;
    };

    // Shows the engine every pending token; the next frame sees it compiled
    const feed = (then) => {
        const pending = [];
        for (const t of seen) {
            if (fed.has(t)) continue;
            // On the page now: the engine has compiled it already
            if (document.getElementsByClassName(t).length) fed.add(t);
            else pending.push(t);
        }
        if (feeding && !then) { feedTimer = setTimeout(() => feed(), TAILWIND_CACHE_FEED_DELAY); return; }
        if (!pending.length || feeding || !findTailwindEngineStyle()) return then && then();
        feeding = true;
        feedTailwindEngine(pending, () => {
            pending.forEach(t => fed.add(t));
            feeding = false;
            if (then) then();
        });
    };

    // Full save: static scan, stringify and write. Throttled; feeding is not
    const save = () => {
        saveTimer = null;
        if (!dirty) return;
        if (feeding) return schedule();
        staticClassTokens(seen);
        feed(() => write(fed));
    };

    const schedule = () => {
        dirty = true;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, Math.max(TAILWIND_CACHE_QUIET, lastSave + TAILWIND_CACHE_MIN_INTERVAL - Date.now()));
    };

    const scheduleFeed = () => {
        clearTimeout(feedTimer);
        feedTimer = setTimeout(() => feed(), TAILWIND_CACHE_FEED_DELAY);
        schedule();
    };

    const tokenObserver = new MutationObserver((mutations) => {
        const before = seen.size;
        for (const m of mutations) {
            if (m.type === 'attributes') {
                if (m.target.hasAttribute('data-tailwind-seed')) continue;
                addClassTokens(m.oldValue, seen);
                addClassTokens(m.target.getAttribute('class'), seen);
                continue;
            }
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1 || n.hasAttribute('data-tailwind-seed')) continue;
                addClassTokens(n.getAttribute('class'), seen);
                if (n.firstElementChild) for (const d of n.querySelectorAll('[class]')) addClassTokens(d.getAttribute('class'), seen);
            }
        }
        if (seen.size !== before) scheduleFeed();
    });
    tokenObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class'] });

    const headObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            const el = m.target.nodeType === 1 ? m.target : m.target.parentNode;
            if (el && el.localName === 'style' && !el.id) return schedule();
            for (const n of m.addedNodes) if (n.localName === 'style') return schedule();
        }
    });
    headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });

    // Leaving: what the engine has compiled is the fed tokens plus what is on the page now
    const flush = () => {
        if (!dirty) return;
        clearTimeout(saveTimer);
        write(documentClassTokens(new Set(fed)));
    };
    const onHidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);

    state.stop = () => {
        tokenObserver.disconnect();
        headObserver.disconnect();
        clearTimeout(saveTimer);
        clearTimeout(feedTimer);
        window.removeEventListener('pagehide', flush);
        document.removeEventListener('visibilitychange', onHidden);
    };
    schedule();
}

function armTailwindCache() {
    const state = window.__tailwindCache;
    if (!state || state.armed) return;
    state.armed = true;
    if (state.record && state.style && state.style.isConnected) watchCachedTailwind(state);
    else recordTailwindEngine(state, null);
}
