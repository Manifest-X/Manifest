/*  Manifest Chat — reference adapters + registry
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  The static/in-memory adapter: a seeded backend of multiple conversations
/*  with a per-conversation view AND an aggregate (virtual conversationId,
/*  fan-out) view. It exercises the whole contract — anchored bidirectional
/*  load, streaming, optimistic+echo reconcile, closed→new-conversation spawn,
/*  unseen-conversationId live inbound, gap/backfill — with no transport. This
/*  is the proof a real adapter (Appwrite, a Cloudflare DO, etc.) slots in the
/*  same shape. Backends own ts and identity; the plugin only projects.
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
    // One backend instance holds all conversations; both adapter views read it.
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

    // page a message list around/before/after an anchor — opaque cursors are
    // just indices here; a real backend encodes hot-log vs archive offset.
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
    // Merges a contact's conversations across channels into one stream; live
    // subscribes at the CONTACT level so a brand-new conversation's first
    // inbound arrives with a never-before-seen conversationId.
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
