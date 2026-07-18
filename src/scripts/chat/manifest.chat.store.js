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
        const _participants = new Map();  // id -> participant
        const _typing = new Map();        // id -> participant
        let cursorOlder = null, cursorNewer = null, lastSeen = null, unsub = null;

        const state = A.reactive({
            messages: [], participants: [], me: null, typing: [],
            status: 'idle', live: false, atStart: false, atEnd: false,
            lastRehome: null, error: null
        });

        function ordered() { return _msgs.slice().sort(byKey); }
        // Fresh per-message snapshots each commit so a keyed x-for re-renders
        // in-place mutations (streaming appends, status) that identity wouldn't trip.
        function commit() { state.messages = ordered().map(m => Object.assign({}, m, { body: Object.assign({}, m.body) })); rev().n++; }
        function commitParticipants() { state.participants = [..._participants.values()]; rev().n++; }
        function commitTyping() { state.typing = [..._typing.values()]; rev().n++; }

        function upsert(raw) {
            const incoming = normalize(raw, ++seq);
            const prev = incoming.id != null ? _byId.get(incoming.id) : null;
            if (prev) {
                // merge — server echo reconciles body/media/status onto the local copy
                Object.assign(prev.body, incoming.body);
                for (const k of Object.keys(incoming)) if (k !== 'body' && k !== '_seq') prev[k] = incoming[k];
            } else {
                _msgs.push(incoming);
                if (incoming.id != null) _byId.set(incoming.id, incoming);
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

        async function open() {
            state.status = 'loading';
            try {
                state.me = adapter.identity ? adapter.identity() : null;
                if (state.me) seenAuthor(state.me);
                ingestLoad(await adapter.load(conversationId, opts.around ? { around: opts.around } : undefined));
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
            const local = normalize({ id: tmp, conversationId, author: state.me, body, replyTo: draft && draft.replyTo, status: 'pending', ts: null, _optimistic: true }, ++seq);
            _msgs.push(local); _byId.set(tmp, local); commit();
            if (!adapter.send) { local.status = 'failed'; local.statusReason = 'unsupported'; commit(); return; }
            try {
                const ack = await adapter.send(conversationId, Object.assign({}, draft, { body }));
                _byId.delete(tmp);
                local.id = ack.id; local.ts = ack.ts; local.status = 'sent'; local._optimistic = false;
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
            close() { try { unsub && unsub(); } catch (_) { } }
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
            get live() { return handles.some(h => h.live); },
            can: { send: handles.some(h => h.can.send) },
            send: (draft, target) => { const h = handles.find(x => x.conversationId === target) || handles[0]; return h.send(draft); },
            tree(o) { return buildTree(this.messages, o); },
            close: () => handles.forEach(h => h.close())
        };
    }

    window.ManifestChatStore = { createHandle, mergeHandles, buildTree, flattenTree };
})();
