/*  Manifest Chat — persisted windows
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  Last `messages` of the `conversations` most recently opened conversations,
/*  on the persisted-$x record store (PERF-PRIMITIVES-DESIGN.md §12.2, primitive 3).
/*  Keys `${scope}|chat|${conversationId}`; index `${scope}|chat` = { recent }.
/*  Off unless manifest.json `chat.persist` (or `ai.persist`) opts in.
*/

(function () {
    'use strict';

    const DEFAULT_MESSAGES = 50;
    const DEFAULT_CONVERSATIONS = 30;
    const DEFAULT_TTL = '7d';
    const WRITE_DEBOUNCE_MS = 500;
    const CONFIGURE_WAIT_MS = 1500;
    const SECRET_PATTERNS = ['*secret*', '*token*', '*password*', 'credentials*'];
    const WIPE_EVENTS = ['manifest:auth:logout', 'manifest:auth:session-cleared'];
    const INDEX = Symbol('index');

    const state = {
        config: null,          // normalized { messages, conversations, ttl, strip } or null (off)
        explicit: false,       // configured at runtime (harness/tests) — manifest not consulted
        ready: null,           // Promise: config + store scope settled
        handles: new Map(),    // conversationId -> { snapshot, count, stale, reset }
        recent: null,          // index in memory (null until read)
        indexPromise: null,
        indexDirty: false,
        pending: new Map(),    // conversationId | INDEX -> due time
        timer: null,
        saved: new Map(),      // conversationId -> { messages, savedAt }
        generation: 0,
        watching: false,
        resetQueued: false
    };

    const noop = () => { };
    const records = () => (window.ManifestDataPersist && window.ManifestDataPersist.records) || null;
    function enabled() { const r = records(); return !!(state.config && r && r.enabled()); }

    // ---- config ---------------------------------------------------------------
    function globToRegExp(pattern) {
        const escaped = String(pattern).split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        return new RegExp('^' + escaped + '$', 'i');
    }

    // strip entries may be dotted paths (`meta.raw`); each segment is a glob
    function compileStrip(list) {
        return list.map(p => String(p).split('.').map(globToRegExp));
    }

    function normalize(raw) {
        if (raw !== true && (!raw || typeof raw !== 'object')) return null;
        const o = raw === true ? {} : raw;
        const n = (v, d) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : d);
        const strip = Array.isArray(o.strip) ? o.strip : (typeof o.strip === 'string' ? [o.strip] : []);
        const r = records();
        const ttlMs = r ? r.ttl(o.ttl === undefined ? DEFAULT_TTL : o.ttl) : 7 * 86400000;
        return {
            messages: n(o.messages, DEFAULT_MESSAGES),
            conversations: n(o.conversations, DEFAULT_CONVERSATIONS),
            ttl: ttlMs,
            strip: compileStrip([...SECRET_PATTERNS, ...strip])
        };
    }

    // Runtime opt-in (same shape as manifest.json `chat.persist`); null/false turns it off
    function configure(raw) {
        state.explicit = true;
        state.config = normalize(raw);
        state.ready = null;
        return bootstrap();
    }

    function manifestConfig(m) {
        if (!m || typeof m !== 'object') return undefined;
        const block = (m.chat && typeof m.chat === 'object' && m.chat) || (m.ai && typeof m.ai === 'object' && m.ai) || null;
        return block ? block.persist : undefined;
    }

    // Config from manifest.json unless configured explicitly; then wait for the
    // data plugin's persist configure (scope expression) before touching the store
    function bootstrap() {
        if (state.ready) return state.ready;
        state.ready = (async () => {
            if (!state.explicit) {
                let m = null;
                try {
                    const cfg = window.ManifestDataConfig;
                    m = cfg && cfg.ensureManifest ? await cfg.ensureManifest()
                        : (window.__manifestLoaded || (window.ManifestComponentsRegistry && window.ManifestComponentsRegistry.manifest) || null);
                } catch (_) { m = null; }
                state.config = normalize(manifestConfig(m));
            }
            if (!state.config) return;
            const dp = window.ManifestDataPersist;
            if (!dp) { state.config = null; return; }
            if (!state.explicit) {
                const until = Date.now() + CONFIGURE_WAIT_MS;
                while (!dp.state.configured && Date.now() < until) await new Promise(r => setTimeout(r, 10));
            }
            dp.records.enable();
            watch();
        })();
        return state.ready;
    }

    // ---- scope / wipe -----------------------------------------------------------
    function watch() {
        if (state.watching) return;
        state.watching = true;
        const queue = () => {
            if (state.resetQueued) return;
            state.resetQueued = true;
            queueMicrotask(() => { state.resetQueued = false; reset(); });
        };
        window.addEventListener('manifest:persist:scope', queue);
        for (const type of WIPE_EVENTS) window.addEventListener(type, queue);
    }

    // Drop every in-memory window and the index; the store's scope prefix already
    // covers the records. Handles go idle — the app re-opens for the new scope.
    function reset() {
        state.generation++;
        state.recent = null;
        state.indexPromise = null;
        state.indexDirty = false;
        state.saved.clear();
        for (const h of state.handles.values()) { try { h.reset(); } catch (_) { } }
        cancel();
    }

    // ---- index ------------------------------------------------------------------
    function adoptIndex(rec) {
        const r = records();
        const ok = rec && typeof rec === 'object' && rec.scope === (r ? r.scope() : '') && Array.isArray(rec.recent);
        state.recent = ok ? rec.recent.filter(id => typeof id === 'string' || typeof id === 'number') : [];
        return state.recent;
    }

    function ensureIndex() {
        if (state.recent) return Promise.resolve(state.recent);
        if (state.indexPromise) return state.indexPromise;
        const gen = state.generation;
        state.indexPromise = (async () => {
            await bootstrap();
            if (!enabled()) return [];
            const got = await records().get([records().key('chat')]);
            if (gen !== state.generation) return [];
            return adoptIndex(got && got[0]);
        })().catch(() => (state.recent = state.recent || []));
        return state.indexPromise;
    }

    // Recency bump; beyond the cap the oldest conversations' records are deleted
    function opened(conversationId) {
        if (conversationId == null) return;
        const gen = state.generation;
        ensureIndex().then(recent => {
            if (gen !== state.generation || !enabled()) return;
            const i = recent.indexOf(conversationId);
            if (i > -1) recent.splice(i, 1);
            recent.unshift(conversationId);
            const evicted = recent.splice(state.config.conversations);
            const r = records();
            for (const id of evicted) { state.pending.delete(id); state.saved.delete(id); }
            if (evicted.length) r.delete(evicted.map(id => r.key('chat', id))).catch(noop);
            state.indexDirty = true;
            state.pending.set(INDEX, Date.now() + WRITE_DEBOUNCE_MS);
            schedule();
        }).catch(noop);
    }

    // ---- hydrate (read path) ----------------------------------------------------
    // Record + index in one transaction on the first open; later opens read the record only
    function hydrate(conversationId) {
        let indexRead = null;
        if (!state.recent && !state.indexPromise) {
            indexRead = { done: false };
            state.indexPromise = new Promise(resolve => { indexRead.resolve = (v) => { indexRead.done = true; resolve(v); }; });
        }
        const gen = state.generation;
        return hydrateRead(conversationId, gen, indexRead)
            .catch(() => null)
            .then(result => { if (indexRead && !indexRead.done) indexRead.resolve(gen === state.generation ? adoptIndex(null) : []); return result; });
    }

    async function hydrateRead(conversationId, gen, indexRead) {
        await bootstrap();
        if (!enabled() || conversationId == null || gen !== state.generation) return null;
        const r = records();
        const keys = [r.key('chat', conversationId)];
        if (indexRead) keys.push(r.key('chat'));
        let got;
        try { got = await r.get(keys); } catch (_) { got = null; }
        if (indexRead) indexRead.resolve(gen === state.generation ? adoptIndex(got && got[1]) : []);
        if (!got || gen !== state.generation) return null;
        const rec = got[0];
        if (!rec) return null;
        if (!r.valid(rec, state.config.ttl) || !Array.isArray(rec.rows)) {
            if (rec.scope === r.scope()) r.delete([rec.key]).catch(noop);
            return null;
        }
        state.saved.set(conversationId, { messages: rec.rows.length, savedAt: rec.savedAt });
        return { messages: rec.rows, savedAt: rec.savedAt };
    }

    // ---- snapshot (write path) --------------------------------------------------
    function stripObject(obj, patterns, depth) {
        const out = {};
        for (const key of Object.keys(obj)) {
            const value = obj[key];
            if (typeof value === 'function' || (depth === 0 && key[0] === '_')) continue;
            const hits = patterns.filter(p => p[depth] && p[depth].test(key));
            if (hits.some(p => p.length === depth + 1)) continue;
            const deeper = hits.filter(p => p.length > depth + 1);
            out[key] = deeper.length && value && typeof value === 'object' && !Array.isArray(value)
                ? stripObject(value, deeper, depth + 1) : value;
        }
        return out;
    }

    function snapshotOf(messages) {
        const tail = messages.length > state.config.messages ? messages.slice(messages.length - state.config.messages) : messages;
        return JSON.parse(JSON.stringify(tail.map(m => stripObject(m, state.config.strip, 0))));
    }

    function touch(conversationId) {
        if (!state.config || !state.handles.has(conversationId)) return;
        state.pending.set(conversationId, Date.now() + WRITE_DEBOUNCE_MS);
        schedule();
    }

    function schedule() {
        if (state.timer !== null || !state.pending.size) return;
        let next = Infinity;
        for (const at of state.pending.values()) if (at < next) next = at;
        state.timer = setTimeout(flushDue, Math.max(0, next - Date.now()));
    }

    function cancel() {
        state.pending.clear();
        if (state.timer !== null) { clearTimeout(state.timer); state.timer = null; }
    }

    function flushDue() {
        state.timer = null;
        const now = Date.now();
        const due = [];
        for (const [key, at] of state.pending) if (at - now <= 5) due.push(key);
        const run = due.length ? flush(due) : Promise.resolve();
        schedule();
        return run.catch(noop);
    }

    // Every due conversation (+ the index) in ONE transaction
    async function flush(due) {
        for (const key of due) state.pending.delete(key);
        const recent = await ensureIndex();
        if (!enabled()) return;
        const gen = state.generation;
        const r = records();
        const savedAt = Date.now();
        const list = [];
        for (const id of due) {
            if (id === INDEX) continue;
            const h = state.handles.get(id);
            if (!h || !recent.includes(id)) continue;
            let rows = null;
            try { const msgs = h.snapshot(); rows = msgs && msgs.length ? snapshotOf(msgs) : null; } catch (_) { rows = null; }
            if (!rows) continue;
            list.push({ key: r.key('chat', id), kind: 'chat', conversation: id, rows, savedAt });
        }
        if (state.indexDirty) { list.push({ key: r.key('chat'), kind: 'chat-index', recent: recent.slice(), savedAt }); state.indexDirty = false; }
        if (!list.length) return;
        await r.put(list);
        if (gen !== state.generation || !enabled()) return;
        for (const rec of list) if (rec.kind === 'chat') state.saved.set(rec.conversation, { messages: rec.rows.length, savedAt });
    }

    // Tests/harness: write everything pending now
    async function flushPending() {
        const due = [...state.pending.keys()];
        if (state.timer !== null) { clearTimeout(state.timer); state.timer = null; }
        if (due.length) await flush(due).catch(noop);
    }

    // ---- handles ----------------------------------------------------------------
    function attach(conversationId, hooks) {
        if (conversationId == null) return noop;
        state.handles.set(conversationId, hooks);
        return () => { if (state.handles.get(conversationId) === hooks) state.handles.delete(conversationId); };
    }

    function anyStale() {
        for (const h of state.handles.values()) if (h.stale()) return true;
        return false;
    }

    function persistence() {
        if (!enabled()) return { enabled: false, conversations: [] };
        const ids = [...(state.recent || [])];
        for (const id of state.handles.keys()) if (!ids.includes(id)) ids.push(id);
        const conversations = ids.map(id => {
            const h = state.handles.get(id);
            const s = state.saved.get(id);
            return { id, messages: s ? s.messages : (h ? h.count() : null), savedAt: s ? s.savedAt : null, stale: h ? h.stale() : false };
        });
        return { enabled: enabled(), conversations };
    }

    window.ManifestChatPersist = {
        WRITE_DEBOUNCE_MS,
        configure, bootstrap, enabled, hydrate, opened, touch, attach, anyStale, persistence, flushPending, reset,
        config: () => state.config,
        state
    };
})();
