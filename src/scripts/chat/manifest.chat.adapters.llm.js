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
