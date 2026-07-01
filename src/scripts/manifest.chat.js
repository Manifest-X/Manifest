/*  Manifest Chat — store / engine
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  Handle = reactive conversation view fed by an adapter; drives intents. The
/*  plugin transports/stores nothing — see CHAT-PLUGIN-DESIGN.md.
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
        function commit() { state.messages = ordered().map(m => Object.assign({}, m, { body: Object.assign({}, m.body) })); }
        function commitParticipants() { state.participants = [..._participants.values()]; }
        function commitTyping() { state.typing = [..._typing.values()]; }

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
            get messages() { return state.messages; },
            get participants() { return state.participants; },
            get me() { return state.me; },
            get typing() { return state.typing; },
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
            tree(o) { void state.messages; return buildTree(state.messages, o); },
            flatTree(o) { void state.messages; return flattenTree(buildTree(state.messages, o)); },
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
        const m = (cid, author, text, minsAgo, extra) =>
            Object.assign({ id: id('m'), conversationId: cid, author, body: { text }, ts: t(minsAgo), status: 'delivered' }, extra || {});

        // 1:1 AI co-pilot
        mk('dm-ai', 'webchat', [me, bot], [
            m('dm-ai', bot, 'Hi — I can help with your account. What do you need?', 12),
            m('dm-ai', me, 'How many free credits do I get?', 11)
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
            async react(cid, mid, emoji) { const c = backend.convs.get(cid); const msg = c && c.messages.find(x => x.id === mid); if (msg) { msg.reactions = [{ emoji, count: 1, byMe: true, by: [backend.me.id] }]; emit(cid, h => h.onReaction && h.onReaction(mid, msg.reactions)); } return { ok: true }; },
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
        // stream an AI reply token-by-token into a conversation
        aiReply(cid, text) {
            const c = backend.convs.get(cid); if (!c) return;
            const mid = backend.id('m');
            const msg = { id: mid, conversationId: cid, author: backend.bot, body: { text: '' }, ts: backend.t(0), status: 'streaming', meta: { authoredBy: 'u_me' } };
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
            const system = opts.system || 'You are a helpful assistant for the Manifest framework docs. Answer in concise markdown.';
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
            function apiMessages(cid, draft) {
                const hist = loadStore(cid).map(r => ({ role: r.role, content: r.text }));
                const media = (draft.body && draft.body.media) || [];
                const blocks = media.map(a => a.kind === 'image'
                    ? { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } }
                    : { type: 'document', source: { type: 'base64', media_type: a.mediaType || 'application/pdf', data: a.data } });
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


/*  Manifest Chat — magic + init
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  Registers $chat. Renders nothing — the author drives their UI off the handle.
/*    open(conversationId, { adapter, around?, aggregate? }) · merge(handles, { order })
/*    adapter(name, factory) · flatten(tree)
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
