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
