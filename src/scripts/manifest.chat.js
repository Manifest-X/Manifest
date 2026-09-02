/* manifest.chat.js — built from scripts/chat/ */

(function () {

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


/*  Manifest Chat — store / engine
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  Handle = reactive conversation view fed by an adapter; drives intents. The
/*  plugin transports/stores nothing — see templates/chat-adapter/README.md.
*/

(function () {
    'use strict';

    // ---- ordering -----------------------------------------------------------
    // Pending (un-acked) messages have no ts → sort to the tail; _seq tiebreaks.
    function tsKey(m) {
        if (m._optimistic && m.ts == null) return Number.POSITIVE_INFINITY;
        const t = m.ts;
        if (typeof t === 'number') return t;
        if (typeof t === 'string') { const p = Date.parse(t); if (!isNaN(p)) return p; }
        return m._seq || 0;
    }
    function byKey(a, b) {
        const ka = tsKey(a), kb = tsKey(b);
        if (ka !== kb) return ka - kb;
        return (a._seq || 0) - (b._seq || 0);
    }

    function normalize(m, seq) {
        const body = m.body && typeof m.body === 'object' ? m.body : { text: m.body == null ? '' : String(m.body) };
        return Object.assign({}, m, { body: Object.assign({ text: '' }, body), _seq: m._seq != null ? m._seq : seq });
    }

    // ---- tree (render-time projection over replyTo) -------------------------
    // roots[] with recursive .replies; unloaded parent → orphan root.
    // maxDepth re-parents deeper replies onto their level-N ancestor (stops
    // indenting past N) while preserving the node's true depth.
    function buildTree(messages, opts) {
        const maxDepth = opts && typeof opts.maxDepth === 'number' ? opts.maxDepth : Infinity;
        const byId = new Map();
        const nodes = messages.map(m => { const n = Object.assign({}, m, { replies: [], depth: 0, childCount: 0, orphan: false }); byId.set(m.id, n); return n; });
        const roots = [];
        for (const n of nodes) {
            const parent = n.replyTo != null ? byId.get(n.replyTo) : null;
            if (n.replyTo != null && !parent) { n.orphan = true; roots.push(n); continue; }
            if (!parent) { roots.push(n); continue; }
            n.depth = parent.depth + 1;
            let host = parent;
            while (host.depth >= maxDepth && host._clampParent) host = host._clampParent;   // re-parent past the cap
            if (host.depth >= maxDepth) n._clampParent = host;
            host.replies.push(n); host.childCount++;
        }
        return roots;
    }

    // DFS flatten — convenience for renderers that prefer a flat list + indent.
    function flattenTree(roots, out) {
        out = out || [];
        for (const n of roots) { out.push(n); if (n.replies && n.replies.length) flattenTree(n.replies, out); }
        return out;
    }

    // ---- shared revision ----------------------------------------------------
    // Bumped on every commit of every handle; list getters touch it so any
    // effect that read chat state — even a stale/empty handle mid-transition —
    // re-arms on the next commit anywhere. Guards against directive effects
    // whose dependency edge to a specific handle's state is lost during a
    // key-flip flush (x-for dying on first load while a sibling x-effect lives).
    let _rev = null;
    function rev() {
        if (!_rev) _rev = window.Alpine.reactive({ n: 0 });
        return _rev;
    }

    // ---- handle -------------------------------------------------------------
    function createHandle(adapter, conversationId, opts) {
        opts = opts || {};
        const A = window.Alpine;
        const isAggregate = !!opts.aggregate;
        let seq = 0;

        const _msgs = [];                 // plain source of truth
        const _byId = new Map();          // id -> plain msg
        const _byExt = new Map();         // meta.externalId -> plain msg (secondary identity)
        const P = () => window.ManifestChatPersist;
        let landed = false;               // first adapter load applied (later hydration is discarded)
        let detach = null;
        const _participants = new Map();  // id -> participant
        const _typing = new Map();        // id -> participant
        let cursorOlder = null, cursorNewer = null, lastSeen = null, unsub = null;

        const state = A.reactive({
            messages: [], participants: [], me: null, typing: [],
            status: 'idle', live: false, atStart: false, atEnd: false,
            lastRehome: null, error: null, stale: false
        });

        function ordered() { return _msgs.slice().sort(byKey); }
        // Fresh per-message snapshots each commit so a keyed x-for re-renders
        // in-place mutations (streaming appends, status) that identity wouldn't trip.
        function commit() {
            state.messages = ordered().map(m => Object.assign({}, m, { body: Object.assign({}, m.body) })); rev().n++;
            if (detach) P().touch(conversationId);
        }
        function commitParticipants() { state.participants = [..._participants.values()]; rev().n++; }
        function commitTyping() { state.typing = [..._typing.values()]; rev().n++; }

        // server echo reconciles body/media/status onto the local copy
        function merge(target, incoming) {
            Object.assign(target.body, incoming.body);
            for (const k of Object.keys(incoming)) if (k !== 'body' && k !== '_seq') target[k] = incoming[k];
        }

        // own echo beating the ack: claim the pending row by meta.clientId
        function claimPending(incoming) {
            const cid = incoming.meta && incoming.meta.clientId;
            if (cid == null || !state.me || !incoming.author || incoming.author.id !== state.me.id) return null;
            return _msgs.find(m => m._optimistic && m._clientId === cid) || null;
        }

        const extOf = (m) => (m && m.meta && m.meta.externalId != null ? m.meta.externalId : null);
        function indexExt(m) { const e = extOf(m); if (e != null) _byExt.set(e, m); }
        function unindexExt(m) { const e = extOf(m); if (e != null && _byExt.get(e) === m) _byExt.delete(e); }

        // identity: id first, then meta.externalId (a matching externalId re-keys the row)
        function upsert(raw) {
            const incoming = normalize(raw, ++seq);
            let prev = incoming.id != null ? _byId.get(incoming.id) : null;
            if (!prev) { const e = extOf(incoming); if (e != null) prev = _byExt.get(e) || null; }
            const pending = prev ? null : claimPending(incoming);
            if (prev) {
                if (incoming.id != null && prev.id !== incoming.id) _byId.delete(prev.id);
                merge(prev, incoming);
                if (prev.id != null) _byId.set(prev.id, prev);
                indexExt(prev);
            } else if (pending) {
                _byId.delete(pending.id);
                merge(pending, incoming);
                pending._optimistic = false;
                if (pending.id != null) _byId.set(pending.id, pending);
                indexExt(pending);
            } else {
                _msgs.push(incoming);
                if (incoming.id != null) _byId.set(incoming.id, incoming);
                indexExt(incoming);
                seenAuthor(incoming.author);
            }
            lastSeen = incoming.id || lastSeen;
            commit();
        }

        function appendPart(id, part) {
            const m = _byId.get(id); if (!m) return;
            if (part && part.text) m.body.text = (m.body.text || '') + part.text;
            m.status = part && part.done ? 'sent' : 'streaming';
            commit();
        }

        function seenAuthor(p) { if (p && p.id != null && !_participants.has(p.id)) { _participants.set(p.id, p); commitParticipants(); } }
        function upsertParticipant(p) { if (p && p.id != null) { _participants.set(p.id, Object.assign(_participants.get(p.id) || {}, p)); commitParticipants(); } }
        function removeParticipant(id) { if (_participants.delete(id)) commitParticipants(); }

        // side: undefined='both'; 'older'/'newer' must NOT clobber the opposite
        // cursor (a directional page reports both, but only its own end advanced).
        function ingestLoad(res, side) {
            if (!res) return;
            (res.participants || []).forEach(upsertParticipant);
            (res.messages || []).forEach(upsert);
            if (side !== 'newer') { if (res.cursorOlder !== undefined) cursorOlder = res.cursorOlder; if (res.atStart !== undefined) state.atStart = res.atStart; }
            if (side !== 'older') { if (res.cursorNewer !== undefined) cursorNewer = res.cursorNewer; if (res.atEnd !== undefined) state.atEnd = res.atEnd; }
        }

        const handlers = {
            onMessage: (m) => upsert(m),                 // MAY carry an unseen conversationId — never rejected
            onMessagePart: (id, part) => appendPart(id, part),
            onParticipant: (p, op) => op === 'removed' ? removeParticipant(p && p.id != null ? p.id : p) : upsertParticipant(p),
            onTyping: (pid, on) => { const p = _participants.get(pid) || { id: pid }; if (on) _typing.set(pid, p); else _typing.delete(pid); commitTyping(); },
            onReceipt: (id, status) => { const m = _byId.get(id); if (m) { m.status = status; commit(); } },
            onReaction: (id, reactions) => { const m = _byId.get(id); if (m) { m.reactions = reactions; commit(); } },
            onGap: (hint) => backfill(hint),
            onConnection: (on) => { state.live = !!on; }
        };

        async function backfill(hint) {
            if (!adapter.load) return;
            const since = (hint && hint.since) || lastSeen;
            try { ingestLoad(await adapter.load(conversationId, { after: since })); } catch (_) { }
        }

        // ---- persisted window (ManifestChatPersist) -------------------------
        // Hydration races the adapter load and lands only if first; the fresh
        // set then reconciles by id / meta.externalId and clears `stale`.
        function hydrateWindow(list) {
            if (landed || !list.length) return;
            for (const raw of list) {
                const m = normalize(raw, ++seq);
                if (m.id == null || _byId.has(m.id) || m._optimistic) continue;
                m._hydrated = true;
                _msgs.push(m); _byId.set(m.id, m); indexExt(m);
                seenAuthor(m.author);
            }
            state.stale = true;
            commit();
        }

        function reconcile(res) {
            const ids = new Set(), exts = new Set();
            for (const m of (res && res.messages) || []) { if (m.id != null) ids.add(m.id); const e = extOf(m); if (e != null) exts.add(e); }
            for (let i = _msgs.length - 1; i >= 0; i--) {
                const m = _msgs[i];
                if (!m._hydrated || ids.has(m.id) || (extOf(m) != null && exts.has(extOf(m)))) continue;
                _msgs.splice(i, 1); _byId.delete(m.id); unindexExt(m);
            }
            ingestLoad(res);
            for (const m of _msgs) delete m._hydrated;
            state.stale = false;
            commit();
        }

        function snapshot() { return state.stale ? null : _msgs.filter(m => !m._optimistic && m.id != null).sort(byKey); }

        // Scope change / logout: drop the window, go idle (the app re-opens for the new scope)
        function reset() {
            try { unsub && unsub(); } catch (_) { }
            unsub = null; landed = false;
            _msgs.length = 0; _byId.clear(); _byExt.clear(); _participants.clear(); _typing.clear();
            cursorOlder = null; cursorNewer = null; lastSeen = null;
            state.stale = false; state.live = false; state.status = 'idle'; state.error = null; state.atStart = false; state.atEnd = false;
            commit(); commitParticipants(); commitTyping();
        }

        if (P() && !isAggregate) detach = P().attach(conversationId, { snapshot, reset, stale: () => state.stale, count: () => _msgs.length });

        async function open() {
            state.status = 'loading';
            if (detach) {
                P().hydrate(conversationId).then(h => { if (h) hydrateWindow(h.messages); }).catch(() => { });
                P().opened(conversationId);
            }
            try {
                state.me = adapter.identity ? adapter.identity() : null;
                if (state.me) seenAuthor(state.me);
                const res = await adapter.load(conversationId, opts.around ? { around: opts.around } : undefined);
                landed = true;
                if (state.stale) reconcile(res); else ingestLoad(res);
                if (adapter.subscribe) { unsub = adapter.subscribe(conversationId, handlers); state.live = true; }
                state.status = 'ready';
                // Settled tick: the seed load resolves amid the consumer's own
                // transition flush; one macrotask commit re-triggers any effect
                // whose mid-transition run raced it.
                setTimeout(() => commit(), 0);
            } catch (e) { state.status = 'error'; state.error = String(e && e.message || e); }
        }

        async function send(draft) {
            const tmp = 'tmp_' + (++seq);
            const body = draft && draft.body ? draft.body : { text: draft && draft.text != null ? draft.text : '' };
            const local = normalize({ id: tmp, conversationId, author: state.me, body, replyTo: draft && draft.replyTo, status: 'pending', ts: null, _optimistic: true, _clientId: tmp }, ++seq);
            _msgs.push(local); _byId.set(tmp, local); commit();
            if (!adapter.send) { local.status = 'failed'; local.statusReason = 'unsupported'; commit(); return; }
            try {
                const ack = await adapter.send(conversationId, Object.assign({}, draft, { body, clientId: tmp }));
                _byId.delete(tmp);
                // A bus that echoes our own send can beat the ack; that echo lands
                // while this row is still tmp-keyed, so it appended as its own entry.
                const echo = ack.id != null ? _byId.get(ack.id) : null;
                if (echo && echo !== local) {
                    merge(local, echo);
                    const at = _msgs.indexOf(echo); if (at > -1) _msgs.splice(at, 1);
                    unindexExt(echo);
                }
                local.id = ack.id; local._optimistic = false;
                indexExt(local);
                if (ack.ts != null) local.ts = ack.ts;
                if (local.status === 'pending') local.status = 'sent';
                if (ack.conversationId && ack.conversationId !== local.conversationId) {
                    const from = local.conversationId; local.conversationId = ack.conversationId;
                    if (!isAggregate) state.lastRehome = { from, to: ack.conversationId };   // single-chat: cockpit must retarget
                }
                _byId.set(local.id, local); commit();
                return ack;
            } catch (e) { local.status = 'failed'; local.statusReason = (e && e.kind) || 'send'; commit(); throw e; }
        }

        async function page(dir) {
            if (!adapter.load) return;
            if (dir === 'older' && (state.atStart || cursorOlder == null)) return;
            if (dir === 'newer' && (state.atEnd || cursorNewer == null)) return;
            ingestLoad(await adapter.load(conversationId, dir === 'older' ? { before: cursorOlder } : { after: cursorNewer }), dir);
        }

        const handle = {
            __v_skip: true,                 // keep Alpine from re-proxying the handle when stored in x-data
            id: 'h_' + Math.round(performance.now()) + '_' + (++seq),
            conversationId, isAggregate,
            get messages() { void rev().n; return state.messages; },
            get participants() { void rev().n; return state.participants; },
            get me() { return state.me; },
            get typing() { void rev().n; return state.typing; },
            get version() { return rev().n; },      // guaranteed-trackable scalar; bumps on every commit
            get status() { return state.status; },
            get stale() { return state.stale; },   // window is a persisted snapshot; the adapter has not landed yet
            get live() { return state.live; },
            get atStart() { return state.atStart; },
            get atEnd() { return state.atEnd; },
            get lastRehome() { return state.lastRehome; },
            get error() { return state.error; },
            get can() {
                return {
                    send: !!adapter.send, edit: !!adapter.edit, retract: !!adapter.retract, react: !!adapter.react,
                    transfer: !!adapter.transfer, addParticipants: !!adapter.addParticipant,
                    typingIndicators: !!adapter.setTyping, readReceipts: !!adapter.markRead,
                    loadOlder: !!adapter.load, loadNewer: !!adapter.load,
                    loadReplies: !!adapter.loadReplies, loadReactions: !!adapter.loadReactions
                };
            },
            tree(o) { void rev().n; void state.messages; return buildTree(state.messages, o); },
            flatTree(o) { void rev().n; void state.messages; return flattenTree(buildTree(state.messages, o)); },
            send,
            edit: (id, body) => adapter.edit && adapter.edit(conversationId, id, body),
            retract: (id) => adapter.retract && adapter.retract(conversationId, id),
            react: (id, emoji) => adapter.react && adapter.react(conversationId, id, emoji),
            unreact: (id, emoji) => adapter.unreact && adapter.unreact(conversationId, id, emoji),
            transfer: (from, to, role) => adapter.transfer && adapter.transfer(conversationId, from, to, role),
            addParticipant: (p) => adapter.addParticipant && adapter.addParticipant(conversationId, p),
            removeParticipant: (id) => adapter.removeParticipant && adapter.removeParticipant(conversationId, id),
            setTyping: (on) => adapter.setTyping && adapter.setTyping(conversationId, on),
            markRead: (upTo) => adapter.markRead && adapter.markRead(conversationId, upTo),
            loadOlder: () => page('older'),
            loadNewer: () => page('newer'),
            loadReplies: (parentId) => adapter.loadReplies && adapter.loadReplies(conversationId, parentId),
            loadReactions: (id) => adapter.loadReactions && adapter.loadReactions(conversationId, id),
            clearRehome: () => { state.lastRehome = null; },
            close() { try { unsub && unsub(); } catch (_) { } if (detach) { detach(); detach = null; } }
        };
        open();
        return handle;
    }

    // ---- merge (small-N read projection; e.g. a Case lens) ------------------
    function mergeHandles(handles, opts) {
        const order = (opts && opts.order) || 'ts';
        return {
            __v_skip: true,
            isMerge: true,
            members: handles,
            get messages() {
                const all = [];
                for (const h of handles) for (const m of h.messages) all.push(Object.assign({ _source: h.conversationId }, m));
                return order === 'ts' ? all.sort(byKey) : all;
            },
            get participants() { const seen = new Map(); for (const h of handles) for (const p of h.participants) seen.set(p.id, p); return [...seen.values()]; },
            get version() { return rev().n; },
            get status() { return handles.some(h => h.status === 'loading') ? 'loading' : (handles.every(h => h.status === 'ready') ? 'ready' : 'idle'); },
            get stale() { return handles.some(h => h.stale); },
            get live() { return handles.some(h => h.live); },
            can: { send: handles.some(h => h.can.send) },
            send: (draft, target) => { const h = handles.find(x => x.conversationId === target) || handles[0]; return h.send(draft); },
            tree(o) { return buildTree(this.messages, o); },
            close: () => handles.forEach(h => h.close())
        };
    }

    window.ManifestChatStore = {
        createHandle, mergeHandles, buildTree, flattenTree,
        // Shared revision, readable with zero handles resolved. Pin it in a list
        // expression (`void $chat.version`) when the handle is looked up through
        // a key that may not exist yet — an Alpine scheduler bug (queueJob drops
        // re-triggers of already-flushed jobs) otherwise strands the directive
        // when a sibling effect creates the handle in the same flush.
        get version() { return rev().n; }
    };
})();


/*  Manifest Chat — reference adapters + registry
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  Seeded in-memory backend with per-conversation and aggregate (fan-out)
/*  views. Exercises the whole contract with no transport, proving a real
/*  adapter (Appwrite, a Cloudflare DO) slots in the same shape.
*/

(function () {
    'use strict';

    const registry = new Map();
    function register(name, factory) { registry.set(name, factory); }
    function resolve(ref, opts) {
        if (ref && typeof ref === 'object') return ref;                  // an adapter object passed directly
        const f = registry.get(ref);
        if (!f) throw new Error('chat: unknown adapter "' + ref + '"');
        return typeof f === 'function' ? f(opts) : f;
    }

    // ---- the shared in-memory backend --------------------------------------
    // One instance holds all conversations; both adapter views read it.
    function createBackend() {
        let seq = 0;
        const now = Date.now();
        const t = (minsAgo) => now - minsAgo * 60000;
        const id = (p) => p + '_' + (++seq);

        const me = { id: 'u_me', kind: 'human', role: 'agent', displayName: 'You', color: '#7c3aed' };
        const ana = { id: 'u_ana', kind: 'human', role: 'member', displayName: 'Ana', color: '#0ea5e9' };
        const bo = { id: 'u_bo', kind: 'human', role: 'member', displayName: 'Bo', color: '#16a34a' };
        const bot = { id: 'u_bot', kind: 'agent', role: 'bot', displayName: 'Acme Bot', color: '#d97706' };
        const player = { id: 'c_p7', kind: 'contact', role: 'player', displayName: 'Player 7', color: '#db2777' };

        // conv: { id, channel, closed, participants[], messages[] }
        const convs = new Map();
        function mk(cid, channel, parts, msgs, closed) {
            convs.set(cid, { id: cid, channel, closed: !!closed, participants: parts, messages: msgs });
        }
        const m = (cid, author, text, minsAgo, extra) => {
            const msg = Object.assign({ id: id('m'), conversationId: cid, author, body: { text }, ts: t(minsAgo), status: 'delivered' }, extra || {});
            if (msg.media) { msg.body.media = msg.media; delete msg.media; }   // media lives on body
            return msg;
        };

        // 1:1 AI co-pilot
        mk('dm-ai', 'webchat', [me, bot], [
            m('dm-ai', bot, 'Hi — I can help with your account. What do you need?', 12),
            m('dm-ai', me, 'How many free credits do I get?', 11)
        ]);

        // Attachment showcase — one of every media kind, both directions
        // (harness-only conversation; asset paths resolve in the test project)
        mk('media-1', 'webchat', [me, bot], [
            m('media-1', me, 'Here is the artwork and the brief.', 22, {
                media: [
                    { kind: 'image', url: '/test/media/sample.png', name: 'artwork.png', mediaType: 'image/png' },
                    { kind: 'document', url: '/test/media/sample.pdf', name: 'brief.pdf', mediaType: 'application/pdf' }
                ]
            }),
            m('media-1', bot, 'Received — and here is everything back in every format:', 20, {
                media: [
                    { kind: 'image', url: '/test/media/sample.png', name: 'render.png', mediaType: 'image/png' },
                    { kind: 'audio', url: '/test/media/sample.wav', name: 'jingle.wav', mediaType: 'audio/wav' },
                    { kind: 'voice', url: '/test/media/sample.wav', name: 'voice note', mediaType: 'audio/wav' },
                    { kind: 'video', url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', name: 'clip.mp4', mediaType: 'video/mp4' },
                    { kind: 'document', url: '/test/media/sample.pdf', name: 'summary.pdf', mediaType: 'application/pdf' }
                ]
            })
        ]);

        // group with reactions + a small reply tree
        const g1 = m('grp-1', ana, 'Ship the v2 doc today?', 30);
        mk('grp-1', 'webchat', [me, ana, bo], [
            g1,
            Object.assign(m('grp-1', bo, '+1, reviewing now', 28), { reactions: [{ emoji: '👍', count: 2, byMe: true }], replyTo: g1.id }),
            Object.assign(m('grp-1', me, 'I’ll cut the release after', 26), { replyTo: g1.id })
        ]);

        // forum-style nested thread (multi-level) for c.tree
        const root = m('forum-1', ana, 'Proposal: drop stored `direction`', 200);
        const r1 = Object.assign(m('forum-1', bo, 'Agree — derive from author', 190), { replyTo: root.id });
        const r2 = Object.assign(m('forum-1', me, 'What about group with N of our identities?', 185), { replyTo: r1.id });
        const r3 = Object.assign(m('forum-1', ana, 'Exactly why binary breaks', 180), { replyTo: r2.id });
        const orphan = Object.assign(m('forum-1', bo, '(reply to a post paged out of view)', 175), { replyTo: 'm_paged_away' });
        mk('forum-1', 'webchat', [me, ana, bo], [root, r1, r2, r3, orphan]);

        // player-7 lifetime history across channels — mostly CLOSED (aggregate lens)
        mk('hist-tg-1', 'telegram', [player, bot], [
            m('hist-tg-1', player, 'deposit stuck', 60 * 24 * 30),
            m('hist-tg-1', bot, 'resolved — refunded', 60 * 24 * 30 + 1, { meta: { authoredBy: 'u_me' } })
        ], true);
        mk('hist-em-1', 'email', [player, me], [
            m('hist-em-1', player, 'bonus question', 60 * 24 * 9),
            m('hist-em-1', me, 'applied to your account', 60 * 24 * 9 + 2)
        ], true);
        mk('hist-wc-1', 'webchat', [player, bot], [
            m('hist-wc-1', player, 'KYC docs?', 60 * 24 * 2),
            m('hist-wc-1', bot, 'uploaded, thanks', 60 * 24 * 2 + 1)
        ], true);

        return { seq: () => ++seq, id, t, me, ana, bo, bot, player, convs };
    }

    const backend = createBackend();
    const subscribers = new Map();   // conversationId -> Set(handlers)  (+ 'contact:c_p7' channel)

    function emit(channel, fn) { const s = subscribers.get(channel); if (s) s.forEach(fn); }
    function deliver(conv, msg) {
        conv.messages.push(msg);
        emit(conv.id, h => h.onMessage && h.onMessage(msg));
        emit('contact:' + backend.player.id, h => h.onMessage && h.onMessage(msg));  // aggregate sees it too
    }

    // page around/before/after an anchor; cursors are just indices here.
    function pageList(list, win, size) {
        win = win || {}; size = size || 20;
        const ids = list.map(x => x.id);
        let start, end;
        if (win.around != null) { const i = Math.max(0, ids.indexOf(win.around)); start = Math.max(0, i - Math.floor(size / 2)); end = Math.min(list.length, start + size); }
        else if (win.before != null) { const i = ids.indexOf(win.before); end = i < 0 ? list.length : i; start = Math.max(0, end - size); }
        else if (win.after != null) { const i = ids.indexOf(win.after); start = i < 0 ? 0 : i + 1; end = Math.min(list.length, start + size); }
        else { start = Math.max(0, list.length - size); end = list.length; }
        return {
            messages: list.slice(start, end),
            cursorOlder: start > 0 ? list[start].id : null,
            cursorNewer: end < list.length ? list[end - 1].id : null,
            atStart: start <= 0, atEnd: end >= list.length
        };
    }

    function sub(channel, handlers) {
        if (!subscribers.has(channel)) subscribers.set(channel, new Set());
        subscribers.get(channel).add(handlers);
        setTimeout(() => handlers.onConnection && handlers.onConnection(true), 0);
        return () => { const s = subscribers.get(channel); if (s) s.delete(handlers); };
    }

    // ---- per-conversation adapter ------------------------------------------
    function staticAdapter() {
        return {
            identity: () => backend.me,
            async load(cid, win) { const c = backend.convs.get(cid); if (!c) return { messages: [], participants: [] }; const p = pageList(c.messages, win); return Object.assign({ participants: c.participants }, p); },
            subscribe: (cid, handlers) => sub(cid, handlers),
            async send(cid, draft) {
                const c = backend.convs.get(cid);
                // closed-never-reopens: a reply into a closed conversation spawns a new one
                let target = c;
                if (c && c.closed) { const nid = backend.id('cht'); backend.convs.set(nid, { id: nid, channel: c.channel, closed: false, participants: c.participants, messages: [] }); target = backend.convs.get(nid); }
                const msg = { id: backend.id('m'), conversationId: target.id, author: backend.me, body: draft.body, replyTo: draft.replyTo, ts: backend.t(0), status: 'sent' };
                setTimeout(() => deliver(target, msg), 60);   // server echo (reconciles media/status by id)
                return { id: msg.id, ts: msg.ts, conversationId: target.id };
            },
            async react(cid, mid, emoji) {
                // toggle: off if I reacted, join if others did, add if new
                const c = backend.convs.get(cid); const msg = c && c.messages.find(x => x.id === mid);
                if (msg) {
                    const rs = (msg.reactions || []).map(r => Object.assign({}, r));
                    const r = rs.find(x => x.emoji === emoji);
                    if (r && r.byMe) { r.count--; r.byMe = false; }
                    else if (r) { r.count++; r.byMe = true; }
                    else rs.push({ emoji, count: 1, byMe: true });
                    msg.reactions = rs.filter(x => x.count > 0);
                    emit(cid, h => h.onReaction && h.onReaction(mid, msg.reactions));
                }
                return { ok: true };
            },
            async addParticipant(cid, p) { const c = backend.convs.get(cid); if (c && !c.participants.some(x => x.id === p.id)) { c.participants.push(p); emit(cid, h => h.onParticipant && h.onParticipant(p, 'added')); } return { ok: true }; },
            async transfer(cid, from, to, role) { emit(cid, h => h.onParticipant && h.onParticipant({ id: to, role: role || 'assignee' }, 'changed')); return { ok: true }; },
            async setTyping(cid, on) { emit(cid, h => h.onTyping && h.onTyping(backend.me.id, on)); },
            async markRead(cid, upTo) { emit(cid, h => h.onReceipt && h.onReceipt(upTo, 'read')); },
            async loadReplies(cid, parentId) { const c = backend.convs.get(cid); return { messages: (c ? c.messages : []).filter(x => x.replyTo === parentId), cursor: null, done: true }; }
        };
    }

    // ---- aggregate adapter (virtual conversationId, fan-out) ----------------
    // Merges a contact's conversations into one stream; subscribes at the
    // CONTACT level so a new conversation's first inbound has an unseen id.
    function aggregateAdapter(opts) {
        const contactId = (opts && opts.contactId) || backend.player.id;
        function memberConvs() { return [...backend.convs.values()].filter(c => c.participants.some(p => p.id === contactId)); }
        function allMsgs() { return memberConvs().flatMap(c => c.messages).sort((a, b) => a.ts - b.ts); }
        return {
            identity: () => backend.me,
            async load(_vid, win) { const list = allMsgs(); const p = pageList(list, win, 12); const seen = new Map(); memberConvs().forEach(c => c.participants.forEach(x => seen.set(x.id, x))); return Object.assign({ participants: [...seen.values()] }, p); },
            subscribe: (_vid, handlers) => sub('contact:' + contactId, handlers),
            async send(_vid, draft) {
                // route by channel; if that channel's latest conv is closed, spawn a new one
                const ch = (draft && draft.viaChannelId) || 'webchat';
                const open = memberConvs().filter(c => c.channel === ch && !c.closed).pop();
                let target = open;
                if (!target) { const nid = backend.id('cht'); backend.convs.set(nid, { id: nid, channel: ch, closed: false, participants: [backend.player, backend.me], messages: [] }); target = backend.convs.get(nid); }
                const msg = { id: backend.id('m'), conversationId: target.id, author: backend.me, body: draft.body, ts: backend.t(0), status: 'sent' };
                setTimeout(() => deliver(target, msg), 60);
                return { id: msg.id, ts: msg.ts, conversationId: target.id };
            }
        };
    }

    // ---- simulation hooks (button-driven; deterministic for verification) ---
    const sim = {
        // stream an AI reply token-by-token into a conversation (media attaches on completion)
        aiReply(cid, text, media) {
            const c = backend.convs.get(cid); if (!c) return;
            const mid = backend.id('m');
            const msg = { id: mid, conversationId: cid, author: backend.bot, body: { text: '', media: media || undefined }, ts: backend.t(0), status: 'streaming', meta: { authoredBy: 'u_me' } };
            c.messages.push(msg);
            emit(cid, h => h.onMessage && h.onMessage(msg));
            const words = (text || 'Every account starts with 5,000 free credits each month.').split(' ');
            let i = 0;
            const tick = setInterval(() => {
                if (i >= words.length) { clearInterval(tick); emit(cid, h => h.onMessagePart && h.onMessagePart(mid, { text: '', done: true })); return; }
                emit(cid, h => h.onMessagePart && h.onMessagePart(mid, { text: (i ? ' ' : '') + words[i] }));
                i++;
            }, 120);
        },
        // drop the live connection, then reconnect with a gap signal
        disconnect(cid) { emit(cid, h => h.onConnection && h.onConnection(false)); emit('contact:' + backend.player.id, h => h.onConnection && h.onConnection(false)); },
        reconnectWithGap(cid, missed) {
            // a message arrived while "disconnected" — exists in the backend but wasn't pushed
            const c = backend.convs.get(cid);
            if (c) c.messages.push({ id: backend.id('m'), conversationId: cid, author: backend.ana, body: { text: missed || 'message you missed while away' }, ts: backend.t(0), status: 'delivered' });
            emit(cid, h => h.onConnection && h.onConnection(true));
            emit(cid, h => h.onGap && h.onGap({ since: c ? c.messages[c.messages.length - 2].id : null }));
        },
        // a brand-new conversation spawns and delivers live to the aggregate stream
        newInboundOnClosedChannel() {
            const nid = backend.id('cht');
            backend.convs.set(nid, { id: nid, channel: 'telegram', closed: false, participants: [backend.player, backend.bot], messages: [] });
            const c = backend.convs.get(nid);
            deliver(c, { id: backend.id('m'), conversationId: nid, author: backend.player, body: { text: 'new message — fresh conversation' }, ts: backend.t(0), status: 'delivered' });
            return nid;
        },
        backend
    };

    register('demo', staticAdapter);
    register('demo-aggregate', aggregateAdapter);

    window.ManifestChatAdapters = { register, resolve, staticAdapter, aggregateAdapter, sim };
})();


/*  Manifest Chat — optional LLM (Claude) adapter
 *  By Andrew Matlock under MIT license · https://manifestx.dev
 *
 *  Reference `claude` adapter: replies stream from a backend proxy holding the
 *  API key (tools/chat-llm-proxy.mjs). $chat never calls the LLM — this adapter
 *  does, behind the same contract. Optional, loaded separately from the bundle.
 *  Attachments ride draft.body.media[] as base64 → image/document blocks.
 */

(function () {
    'use strict';

    function ready(fn) {
        if (window.ManifestChatAdapters) return fn();
        const t = setInterval(() => { if (window.ManifestChatAdapters) { clearInterval(t); fn(); } }, 20);
        setTimeout(() => clearInterval(t), 5000);
    }

    ready(function () {
        const USER = { id: 'you', kind: 'human', role: 'user', displayName: 'You', color: '#7c3aed' };
        const BOT = { id: 'claude', kind: 'agent', role: 'assistant', displayName: 'Claude', color: '#d97706' };

        function claudeAdapter(opts) {
            opts = opts || {};
            // Same-origin relay mnfst-run serves for an `ai` block; override via
            // opts.endpoint / window.CHAT_LLM_ENDPOINT.
            const endpoint = opts.endpoint || window.CHAT_LLM_ENDPOINT || '/_ai/chat';
            // only when set — the relay's ai block (system + grounding) is the default
            const system = opts.system || undefined;
            const handlers = {};   // conversationId -> subscribe handlers
            let seq = 0;
            const id = (p) => p + '_' + Date.now().toString(36) + '_' + (++seq);
            const lsKey = (cid) => 'mnfst.chat.' + cid;

            // text-only persistence so docs sessions survive reload (attachments stay ephemeral)
            function loadStore(cid) { try { return JSON.parse(localStorage.getItem(lsKey(cid)) || '[]'); } catch { return []; } }
            function saveMsg(cid, m) {
                const all = loadStore(cid);
                all.push({ id: m.id, role: m.author.kind === 'agent' ? 'assistant' : 'user', text: m.body.text, ts: m.ts });
                try { localStorage.setItem(lsKey(cid), JSON.stringify(all.slice(-200))); } catch { }
            }
            const toMsg = (r) => ({ id: r.id, conversationId: null, author: r.role === 'assistant' ? BOT : USER, body: { text: r.text }, ts: r.ts, status: 'delivered' });

            // Build the Anthropic messages array; attachments → image/document blocks.
            // Only what the API accepts is forwarded (images + PDFs with data);
            // audio/video/voice render locally but don't reach the model.
            function apiMessages(cid, draft) {
                const hist = loadStore(cid).map(r => ({ role: r.role, content: r.text }));
                const media = ((draft.body && draft.body.media) || []).filter(a =>
                    a.data && (a.kind === 'image' || a.mediaType === 'application/pdf'));
                const blocks = media.map(a => a.kind === 'image'
                    ? { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } }
                    : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
                const text = (draft.body && draft.body.text) || draft.text || '';
                const last = blocks.length ? { role: 'user', content: [...blocks, { type: 'text', text }] } : { role: 'user', content: text };
                return [...hist, last];
            }

            async function streamReply(cid) {
                const h = handlers[cid]; if (!h) return;
                const messages = streamReply._pending; streamReply._pending = null;
                const mid = id('m');
                h.onMessage && h.onMessage({ id: mid, conversationId: cid, author: BOT, body: { text: '' }, ts: Date.now(), status: 'streaming', meta: { model: opts.model } });
                let full = '';
                try {
                    const resp = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ system, model: opts.model, messages }) });
                    const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
                    for (; ;) {
                        const { done, value } = await reader.read(); if (done) break;
                        buf += dec.decode(value, { stream: true });
                        let i;
                        while ((i = buf.indexOf('\n\n')) >= 0) {
                            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
                            const line = frame.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
                            let evt; try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
                            if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
                                full += evt.delta.text; h.onMessagePart && h.onMessagePart(mid, { text: evt.delta.text });
                            } else if (evt.type === 'error') { full += '\n\n_(error: ' + (evt.error && evt.error.message) + ')_'; h.onMessagePart && h.onMessagePart(mid, { text: '\n\n_(error)_' }); }
                        }
                    }
                } catch (e) { h.onMessagePart && h.onMessagePart(mid, { text: '\n\n_(proxy unreachable — is tools/chat-llm-proxy.mjs running?)_' }); full += ' (proxy unreachable)'; }
                h.onMessagePart && h.onMessagePart(mid, { text: '', done: true });
                saveMsg(cid, { id: mid, author: BOT, body: { text: full }, ts: Date.now() });
            }

            return {
                identity: () => USER,
                async load(cid) { return { messages: loadStore(cid).map(toMsg), participants: [USER, BOT] }; },
                subscribe(cid, h) { handlers[cid] = h; setTimeout(() => h.onConnection && h.onConnection(true), 0); return () => { delete handlers[cid]; }; },
                async send(cid, draft) {
                    const mid = id('m'); const ts = Date.now();
                    saveMsg(cid, { id: mid, author: USER, body: { text: (draft.body && draft.body.text) || draft.text || '' }, ts });
                    streamReply._pending = apiMessages(cid, draft);
                    setTimeout(() => streamReply(cid), 30);   // assistant reply streams in as a separate inbound
                    return { id: mid, ts };
                }
            };
        }

        window.ManifestChatAdapters.register('claude', claudeAdapter);
    });
})();


/*  Manifest Chat — Appwrite adapter (conversations as app data)
 *  By Andrew Matlock under MIT license
 *  https://manifestx.dev
 *
 *  Messages live as rows in an Appwrite table; inbound arrives over Appwrite
 *  Realtime; identity comes from $auth (guest sessions cover anonymous use).
 *  Built for comments, support threads, and small-group chat — high-volume
 *  messaging belongs on a purpose-built bus behind a custom adapter.
 *
 *  Config: opts { databaseId, tableId, ttlHours } or manifest.json
 *  chat: { appwriteDatabaseId, appwriteTableId, ttlHours }.
 *  Table columns: conversationId (indexed) · text · authorId · authorName ·
 *  authorColor? · replyTo?  — ts/id come from $createdAt/$id.
 */

(function () {
    'use strict';

    function ready(fn) {
        if (window.ManifestChatAdapters) return fn();
        const t = setInterval(() => { if (window.ManifestChatAdapters) { clearInterval(t); fn(); } }, 20);
        setTimeout(() => clearInterval(t), 5000);
    }

    ready(function () {
        function hashColor(id) {
            let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
            return `hsl(${h % 360} 60% 45%)`;
        }

        function appwriteAdapter(opts) {
            opts = opts || {};
            let cfg = null;

            async function config() {
                if (cfg) return cfg;
                let databaseId = opts.databaseId, tableId = opts.tableId, ttlHours = opts.ttlHours;
                if ((!databaseId || !tableId) && window.ManifestDataConfig && window.ManifestDataConfig.ensureManifest) {
                    const m = await window.ManifestDataConfig.ensureManifest();
                    const c = (m && m.chat) || {};
                    databaseId = databaseId || c.appwriteDatabaseId;
                    tableId = tableId || c.appwriteTableId;
                    if (ttlHours == null) ttlHours = c.ttlHours;
                }
                if (!databaseId || !tableId) console.warn('[Manifest Chat] appwrite adapter needs databaseId + tableId (opts or manifest.json chat block).');
                cfg = { databaseId, tableId, ttlHours };
                return cfg;
            }

            function me() {
                const auth = window.Alpine ? window.Alpine.store('auth') : null;
                const u = auth && auth.user;
                if (u && u.$id) return { id: u.$id, kind: 'human', displayName: u.name || u.email || 'Guest', color: hashColor(u.$id) };
                let gid = null;
                try { gid = localStorage.getItem('mnfst.chat.gid'); if (!gid) { gid = 'g_' + Math.random().toString(36).slice(2, 10); localStorage.setItem('mnfst.chat.gid', gid); } } catch (_) { gid = 'g_anon'; }
                return { id: gid, kind: 'human', displayName: 'Guest', color: hashColor(gid) };
            }

            function toMsg(row) {
                return {
                    id: row.$id, conversationId: row.conversationId,
                    author: { id: row.authorId, kind: 'human', displayName: row.authorName, color: row.authorColor || hashColor(row.authorId) },
                    body: { text: row.text }, replyTo: row.replyTo || undefined,
                    ts: row.$createdAt, status: 'delivered'
                };
            }

            return {
                identity: () => me(),

                async load(cid) {
                    const { databaseId, tableId, ttlHours } = await config();
                    if (!databaseId) return { messages: [], participants: [] };
                    // tablesDB directly (not loadTableRows): public read("any") tables
                    // must load before any session exists — no auth gate on reads.
                    const services = await window.ManifestDataAppwrite.getAppwriteDataServices();
                    const Q = window.Appwrite.Query;
                    const queries = [Q.equal('conversationId', cid), Q.orderDesc('$createdAt'), Q.limit(100)];
                    if (ttlHours) queries.push(Q.greaterThan('$createdAt', new Date(Date.now() - ttlHours * 3600e3).toISOString()));
                    const res = await services.tablesDB.listRows({ databaseId, tableId, queries });
                    return { messages: res.rows.map(toMsg).reverse(), participants: [] };
                },

                subscribe(cid, handlers) {
                    let unsub = null, closed = false;
                    (async () => {
                        const { databaseId, tableId } = await config();
                        if (!databaseId) return;
                        const services = await window.ManifestDataAppwrite.getAppwriteDataServices();
                        if (!services || !services.realtime || closed) return;
                        unsub = services.realtime.subscribe(`databases.${databaseId}.tables.${tableId}.rows`, (res) => {
                            if (!res || !res.payload || res.payload.conversationId !== cid) return;
                            const events = Array.isArray(res.events) ? res.events : [res.events];
                            if (events.some(e => typeof e === 'string' && e.endsWith('.create'))) handlers.onMessage(toMsg(res.payload));
                        });
                        if (handlers.onConnection) handlers.onConnection(true);
                    })();
                    return () => { closed = true; try { unsub && unsub(); } catch (_) { } };
                },

                async send(cid, draft) {
                    const { databaseId, tableId } = await config();
                    const auth = window.Alpine ? window.Alpine.store('auth') : null;
                    if (auth && !auth.isAuthenticated && typeof auth.requestGuest === 'function') {
                        try { await auth.requestGuest(); } catch (_) { }   // guests may create
                    }
                    const who = me();
                    const text = (draft.body && draft.body.text) || draft.text || '';
                    const row = await window.ManifestDataAppwrite.createRow(databaseId, tableId, {
                        conversationId: cid, text,
                        authorId: who.id, authorName: who.displayName, authorColor: who.color,
                        replyTo: draft.replyTo || null
                    });
                    return { id: row.$id, ts: row.$createdAt };
                }
            };
        }

        window.ManifestChatAdapters.register('appwrite', appwriteAdapter);
    });
})();


/*  Manifest Chat — magic + init
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  Registers $chat. Renders nothing — the author drives their UI off the handle.
/*    open(conversationId, { adapter, around?, aggregate? }) · merge(handles, { order })
/*    adapter(name, factory) · flatten(tree) · stale · persistence()
*/

(function () {
    'use strict';

    function api() {
        const Store = window.ManifestChatStore;
        const Adapters = window.ManifestChatAdapters;
        return {
            open(conversationId, opts) {
                opts = opts || {};
                const adapter = Adapters.resolve(opts.adapter, opts);
                const aggregate = opts.aggregate || (typeof opts.adapter === 'string' && /aggregate/.test(opts.adapter));
                return Store.createHandle(adapter, conversationId, Object.assign({}, opts, { aggregate }));
            },
            merge(handles, o) { return Store.mergeHandles(handles, o); },
            adapter(name, factory) { if (factory === undefined) return Adapters.resolve(name); Adapters.register(name, factory); },
            flatten(tree) { return Store.flattenTree(tree); },
            get version() { return Store.version; },   // shared revision — trackable even before any handle resolves
            get stale() { const P = window.ManifestChatPersist; return !!(P && P.anyStale()); },   // any open window still a persisted snapshot
            persistence() { const P = window.ManifestChatPersist; return P ? P.persistence() : { enabled: false, conversations: [] }; },
            get sim() { return Adapters.sim; }      // demo/sim hooks; harmless in prod (no callers)
        };
    }

    function registerMagic() {
        if (!window.Alpine || typeof window.Alpine.magic !== 'function') return false;
        if (registerMagic._done) return true;
        // Bind the api once; $chat.* are stable references (handles carry their own reactivity).
        const instance = api();
        window.Alpine.magic('chat', () => instance);
        registerMagic._done = true;
        return true;
    }

    function ensureInitialized() {
        if (!window.ManifestChatStore || !window.ManifestChatAdapters) return;
        registerMagic();
        if (window.ManifestChatPersist) window.ManifestChatPersist.bootstrap();
    }

    window.ensureManifestChatInitialized = ensureInitialized;

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureInitialized);
    document.addEventListener('alpine:init', ensureInitialized);

    if (window.Alpine && typeof window.Alpine.magic === 'function') {
        setTimeout(ensureInitialized, 0);
    } else {
        const check = setInterval(() => {
            if (window.Alpine && typeof window.Alpine.magic === 'function') { clearInterval(check); ensureInitialized(); }
        }, 10);
        setTimeout(() => clearInterval(check), 5000);
    }
})();


})();
