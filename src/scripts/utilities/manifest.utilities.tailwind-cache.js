// Tailwind engine output cache: the loader replays it (manifest.js replayTailwindCache);
// this side watches for anything it doesn't cover and records the engine's output.

const TAILWIND_CACHE_IGNORED = new Set(['dark', 'light', 'window-resizing']);
const TAILWIND_CACHE_MAX_TOKENS = 6000;
const TAILWIND_CACHE_MAX_CSS = 256 * 1024;
const TAILWIND_CACHE_ENTRIES = 4;
const TAILWIND_CACHE_BUDGET = 1024 * 1024;
const TAILWIND_CACHE_QUIET = 1000;
const TAILWIND_CACHE_MIN_INTERVAL = 10000;
const TAILWIND_CACHE_FEED_DELAY = 250;
const TAILWIND_CACHE_SKIP_PATHS = 32;
const TAILWIND_CACHE_OVER_IDS = 16;
const TAILWIND_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const TAILWIND_CACHE_STRINGS = 4000;

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

// Class strings already split: churn mostly toggles between a few, so each is split once
function addClassString(value, into, done) {
    if (!value || done.has(value)) return;
    if (done.size > TAILWIND_CACHE_STRINGS) done.clear();
    done.add(value);
    addClassTokens(value, into);
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

// Class tokens a later visit may need beyond what the observers saw: <template> contents,
// x-transition values and literal :class strings
const TAILWIND_TRANSITION_XPATH = ".//*[@*[starts-with(name(), 'x-transition:')]]";
function staticClassTokens(into) {
    const scan = (root) => {
        for (const el of root.querySelectorAll('[\\:class], [x-bind\\:class]')) {
            literalClassTokens(el.getAttribute(':class') || el.getAttribute('x-bind:class') || '', into);
        }
        let hits = null;
        try {
            const snap = document.evaluate(TAILWIND_TRANSITION_XPATH, root, null, 7, null);
            hits = Array.from({ length: snap.snapshotLength }, (_, i) => snap.snapshotItem(i));
        } catch (e) {
            hits = root.querySelectorAll('*');
        }
        for (const el of hits) {
            for (const a of el.attributes) if (a.name.startsWith('x-transition:')) addClassTokens(a.value, into);
        }
        for (const t of root.querySelectorAll('template')) {
            if (!t.content || t.hasAttribute('data-tailwind-seed')) continue;
            for (const el of t.content.querySelectorAll('[class]')) addClassTokens(el.getAttribute('class'), into);
            scan(t.content);
        }
    };
    scan(document);
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

function holdsTailwindBlock(node) {
    return isTailwindBlock(node) || !!(node && node.nodeType === 1 && node.firstElementChild && node.querySelector('style[type="text/tailwindcss"]'));
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
    const known_strings = new Set();
    const blockObservers = [];
    let loading = false;
    let observer = null;
    let swap = null;
    let ready = document.readyState !== 'loading';

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

    // parsed: the mismatch was in the document by DOMContentLoaded (or when the watcher armed)
    const checkBlocks = (parsed = !ready) => {
        const variants = tailwindVariantsText();
        const ok = sameTailwindSequence(tailwindAuthorBlockTexts(), rec.blocks) &&
            (variants === null || rec.variants === undefined || variants === rec.variants);
        if (ok) return true;
        // A block in the parsed page: the cached sheet is another page's theme, so drop it now.
        // One added by script later: keep the previous, correct sheet until the engine's replaces it.
        if (parsed) {
            if (state.style) state.style.remove();
            state.style = null;
            skipTailwindCachePath(state);
        }
        load('config');
        return false;
    };

    const watchBlock = (el) => {
        const o = new MutationObserver(() => checkBlocks());
        o.observe(el, { characterData: true, childList: true, subtree: true });
        blockObservers.push(o);
    };

    const unseenIn = (value, unseen) => {
        if (!value || known_strings.has(value)) return;
        let all = true;
        for (const t of value.split(/\s+/)) {
            if (t && !TAILWIND_CACHE_IGNORED.has(t) && !known.has(t)) { unseen.add(t); all = false; }
        }
        if (all) {
            if (known_strings.size > TAILWIND_CACHE_STRINGS) known_strings.clear();
            known_strings.add(value);
        }
    };

    const arm = () => {
        observer = new MutationObserver((mutations) => {
            if (loading) return;
            const unseen = new Set();
            let blocks = false;
            for (const m of mutations) {
                if (m.type === 'attributes') {
                    if (m.attributeName === 'type') { if (m.target.localName === 'style') blocks = true; continue; }
                    // Old values catch classes that came and went within one task (x-transition)
                    unseenIn(m.oldValue, unseen);
                    unseenIn(m.target.getAttribute('class'), unseen);
                    continue;
                }
                if (isTailwindBlock(m.target)) blocks = true;
                for (const n of m.removedNodes) if (holdsTailwindBlock(n)) blocks = true;
                for (const n of m.addedNodes) {
                    if (n.nodeType !== 1 || n.hasAttribute('data-tailwind-seed')) continue;
                    if (isTailwindBlock(n)) { blocks = true; watchBlock(n); }
                    unseenIn(n.getAttribute('class'), unseen);
                    if (n.firstElementChild) {
                        for (const d of n.querySelectorAll('[class]')) unseenIn(d.getAttribute('class'), unseen);
                        for (const s of n.querySelectorAll('style[type="text/tailwindcss"]')) { blocks = true; watchBlock(s); }
                    }
                }
            }
            if (blocks && !checkBlocks()) return;
            if (unseen.size) load('unseen', Array.from(unseen));
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'type'] });
        document.querySelectorAll('style[type="text/tailwindcss"]').forEach(watchBlock);
    };

    const scanAll = () => {
        const unseen = new Set();
        for (const el of document.querySelectorAll('[class]')) if (!el.hasAttribute('data-tailwind-seed')) unseenIn(el.getAttribute('class'), unseen);
        if (unseen.size) load('unseen', Array.from(unseen));
    };

    touchTailwindCacheEntry(state);
    arm();
    if (!checkBlocks(true)) return;
    scanAll();
    const onReady = () => {
        if (loading) return;
        // A shipped sheet means the eager path; blocks parsed in <body> must match too
        if (shippedUtilitiesSheetPresent()) return load('shipped');
        const ok = checkBlocks(true);
        ready = true;
        if (ok) scanAll();
    };
    if (!ready) document.addEventListener('DOMContentLoaded', onReady, { once: true });
    else onReady();
}

function readTailwindCacheIndex(state) {
    try {
        const index = JSON.parse(localStorage.getItem(state.key) || 'null');
        if (index && Array.isArray(index.ids) && index.sizes && typeof index.sizes === 'object') {
            if (!index.skip || typeof index.skip !== 'object' || Array.isArray(index.skip)) index.skip = {};
            if (!index.over || typeof index.over !== 'object') index.over = {};
            return index;
        }
    } catch (e) { /* rebuilt below */ }
    return { ids: [], sizes: {}, skip: {}, over: {} };
}

function saveTailwindCacheIndex(state, index) {
    try {
        localStorage.setItem(state.key, JSON.stringify(index));
        return true;
    } catch (e) {
        return false;
    }
}

// A replayed entry counts as recently used
function touchTailwindCacheEntry(state) {
    try {
        const index = readTailwindCacheIndex(state);
        if (!state.id || index.ids[0] === state.id || !index.ids.includes(state.id)) return;
        index.ids = [state.id, ...index.ids.filter(x => x !== state.id)];
        saveTailwindCacheIndex(state, index);
    } catch (e) { /* order only */ }
}

// This page (by pathname) needed a block in <body>: visits in the next 7 days go straight to the engine
function skipTailwindCachePath(state) {
    try {
        if (!state.pathId) return;
        state.skipped = true;
        const index = readTailwindCacheIndex(state);
        index.skip[state.pathId] = Date.now();
        const paths = Object.keys(index.skip).sort((a, b) => index.skip[b] - index.skip[a]);
        for (const old of paths.slice(TAILWIND_CACHE_SKIP_PATHS)) delete index.skip[old];
        saveTailwindCacheIndex(state, index);
    } catch (e) { /* replay only */ }
}

function isTailwindCacheOver(index, id) {
    const t = index.over[id];
    return typeof t === 'number' && Date.now() - t >= 0 && Date.now() - t <= TAILWIND_CACHE_MAX_AGE;
}

// Over the cap for this block set: no entry, and later visits skip recording
function markTailwindCacheOver(state, id) {
    try {
        const index = readTailwindCacheIndex(state);
        index.over[id] = Date.now();
        const ids = Object.keys(index.over).sort((a, b) => index.over[b] - index.over[a]);
        for (const old of ids.slice(TAILWIND_CACHE_OVER_IDS)) delete index.over[old];
        index.ids = index.ids.filter(x => x !== id);
        delete index.sizes[id];
        localStorage.removeItem(`${state.key}:${id}`);
        saveTailwindCacheIndex(state, index);
    } catch (e) { /* recording stops anyway */ }
}

// Keys under this cache's prefix that the index doesn't list (lost multi-tab races, older versions)
function sweepTailwindCache(state, index) {
    const prefix = state.key.slice(0, state.key.lastIndexOf(':') + 1);
    const keep = new Set([state.key, ...index.ids.map(id => `${state.key}:${id}`)]);
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix) && !keep.has(k)) localStorage.removeItem(k);
    }
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
        const json = JSON.stringify(record);
        index.ids = [id, ...index.ids.filter(x => x !== id)];
        index.sizes[id] = json.length;
        delete index.over[id];
        const total = () => index.ids.reduce((n, x) => n + (index.sizes[x] || 0), 0);
        while (index.ids.length > 1 && (index.ids.length > TAILWIND_CACHE_ENTRIES || total() > TAILWIND_CACHE_BUDGET)) drop(index.ids[index.ids.length - 1]);
        sweepTailwindCache(state, index);
        for (;;) {
            try {
                localStorage.setItem(entryKey, json);
                localStorage.setItem(state.key, JSON.stringify(index));
                return true;
            } catch (e) {
                if (index.ids.length <= 1) {
                    drop(id);
                    saveTailwindCacheIndex(state, index);
                    return false;
                }
                drop(index.ids[index.ids.length - 1]);
            }
        }
    } catch (e) {
        return false;
    }
}

// Engine mode: record its output and every token it has been shown under the current blocks
function recordTailwindEngine(state, seedTokens) {
    if (state.recording) return;
    state.recording = true;
    if (state.parsedMismatch && !state.skipped) skipTailwindCachePath(state);
    const blockId = () => state.idFor(tailwindAuthorBlockTexts());
    if (isTailwindCacheOver(readTailwindCacheIndex(state), blockId())) return;

    const seenStrings = new Set();
    const seen = documentClassTokens(new Set(seedTokens || []));
    // Tokens the engine has compiled under the current blocks; a block change empties it
    let fed = new Set(seedTokens || []);
    let gen = 0;
    let engineGen = findTailwindEngineStyle() ? 0 : -1;
    let dirty = true;
    let saveTimer = null;
    let feedTimer = null;
    let lastSave = 0;
    let feeding = false;
    let stopped = false;
    const blockObservers = [];

    const overCap = (engine) => (engine && engine.textContent.length > TAILWIND_CACHE_MAX_CSS) || seen.size > TAILWIND_CACHE_MAX_TOKENS;
    const giveUp = () => {
        stop();
        markTailwindCacheOver(state, blockId());
        state.over = true;
    };

    const write = (tokens) => {
        if (state.parsedMismatch && !state.skipped) skipTailwindCachePath(state);
        if (stopped || shippedUtilitiesSheetPresent()) return;
        const engine = findTailwindEngineStyle();
        if (!engine) return;
        // Only a sheet built from the current blocks, with tokens shown under them
        if (engineGen !== gen) return schedule();
        if (overCap(engine)) return giveUp();
        dirty = false;
        lastSave = Date.now();
        const body = !!(document.body && document.body.querySelector('style[type="text/tailwindcss"]'));
        const record = { v: state.v, t: lastSave, blocks: tailwindAuthorBlockTexts(), variants: tailwindVariantsText(), body, tokens: Array.from(tokens), css: engine.textContent };
        if (writeTailwindCache(state, record)) state.saved = record;
    };

    // Shows the engine every pending token; the next frame sees it compiled
    const feed = (then) => {
        if (stopped) return;
        if (feeding && !then) { feedTimer = setTimeout(() => feed(), TAILWIND_CACHE_FEED_DELAY); return; }
        const engine = findTailwindEngineStyle();
        if (feeding || !engine || engineGen !== gen) return then && then();
        if (overCap(engine)) return giveUp();
        // On the page now: the engine compiled it in its own pass
        const present = documentClassTokens(new Set());
        const pending = [];
        for (const t of seen) {
            if (fed.has(t)) continue;
            if (present.has(t)) fed.add(t);
            else pending.push(t);
        }
        if (!pending.length) return then && then();
        feeding = true;
        const startGen = gen;
        feedTailwindEngine(pending, () => {
            feeding = false;
            if (gen === startGen) pending.forEach(t => fed.add(t));
            if (then) then();
        });
    };

    // Full save: static scan, stringify and write. Throttled; feeding is not
    const save = () => {
        saveTimer = null;
        if (!dirty || stopped) return;
        if (feeding) return schedule();
        if (overCap(findTailwindEngineStyle())) return giveUp();
        staticClassTokens(seen);
        feed(() => write(fed));
    };

    const schedule = () => {
        if (stopped) return;
        dirty = true;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, Math.max(TAILWIND_CACHE_QUIET, lastSave + TAILWIND_CACHE_MIN_INTERVAL - Date.now()));
    };

    const scheduleFeed = () => {
        clearTimeout(feedTimer);
        feedTimer = setTimeout(() => feed(), TAILWIND_CACHE_FEED_DELAY);
        schedule();
    };

    // Any block change ends recording for this page view: the engine rebuilds on some changes and not
    // others (a removal keeps the removed theme), and no later sheet can be attributed to a full build
    const blockChanged = () => {
        if (state.parsedMismatch && !state.skipped) skipTailwindCachePath(state);
        gen++;
        fed = new Set();
        state.recordingEnded = 'blocks';
        stop();
    };
    const watchBlock = (el) => {
        const o = new MutationObserver(blockChanged);
        o.observe(el, { characterData: true, childList: true, subtree: true });
        blockObservers.push(o);
    };

    const tokenObserver = new MutationObserver((mutations) => {
        const before = seen.size;
        let blocks = false;
        for (const m of mutations) {
            if (m.type === 'attributes') {
                if (m.attributeName === 'type') { if (m.target.localName === 'style') blocks = true; continue; }
                if (m.target.hasAttribute('data-tailwind-seed')) continue;
                addClassString(m.oldValue, seen, seenStrings);
                addClassString(m.target.getAttribute('class'), seen, seenStrings);
                continue;
            }
            if (isTailwindBlock(m.target)) blocks = true;
            for (const n of m.removedNodes) if (holdsTailwindBlock(n)) blocks = true;
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1 || n.hasAttribute('data-tailwind-seed')) continue;
                if (isTailwindBlock(n)) { blocks = true; watchBlock(n); }
                addClassString(n.getAttribute('class'), seen, seenStrings);
                if (n.firstElementChild) {
                    for (const d of n.querySelectorAll('[class]')) addClassString(d.getAttribute('class'), seen, seenStrings);
                    for (const s of n.querySelectorAll('style[type="text/tailwindcss"]')) { blocks = true; watchBlock(s); }
                }
            }
        }
        if (blocks) blockChanged();
        else if (seen.size !== before) scheduleFeed();
    });
    tokenObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'type'] });
    document.querySelectorAll('style[type="text/tailwindcss"]').forEach(watchBlock);

    // Engine sheet updates: it now reflects the current blocks
    const headObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            const el = m.target.nodeType === 1 ? m.target : m.target.parentNode;
            if ((el && isTailwindEngineStyle(el)) || Array.from(m.addedNodes).some(n => n.nodeType === 1 && isTailwindEngineStyle(n))) {
                // First sheet built from the current blocks: show it what it lost in the rebuild
                const rebuilt = engineGen !== gen;
                engineGen = gen;
                return rebuilt ? scheduleFeed() : schedule();
            }
        }
    });
    headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });

    // Leaving: what the engine has compiled is the fed tokens plus what is on the page now
    const flush = () => {
        if (!dirty || stopped || engineGen !== gen) return;
        clearTimeout(saveTimer);
        write(documentClassTokens(new Set(fed)));
    };
    const onHidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);

    const stop = () => {
        stopped = true;
        tokenObserver.disconnect();
        headObserver.disconnect();
        blockObservers.forEach(o => o.disconnect());
        clearTimeout(saveTimer);
        clearTimeout(feedTimer);
        window.removeEventListener('pagehide', flush);
        document.removeEventListener('visibilitychange', onHidden);
    };
    state.stop = stop;
    schedule();
}

function armTailwindCache() {
    const state = window.__tailwindCache;
    if (!state || state.armed) return;
    state.armed = true;
    // Replay is decided once <head> is parsed: watch or record after that
    if (state.decision) state.decision.then(() => startTailwindCache(state));
    else startTailwindCache(state);
}

function startTailwindCache(state) {
    if (state.parsedMismatch && !state.skipped) skipTailwindCachePath(state);
    if (state.record && state.style && state.style.isConnected) watchCachedTailwind(state);
    else recordTailwindEngine(state, null);
}
