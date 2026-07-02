/*  Manifest Chat — adapter skeleton
 *  Copy, rename, and fill in the fetch/stream calls for your backend.
 *  Contract reference: README.md in this folder.
 */

document.addEventListener('alpine:init', () => {
    window.ManifestChatAdapters.register('mybackend', (opts) => {
        const base = (opts && opts.endpoint) || '/api/chats'

        return {
            // ---- required ----------------------------------------------------
            identity() {
                return { id: 'u1', kind: 'human', displayName: 'Me' }
            },

            async load(conversationId, window) {
                const q = new URLSearchParams()
                if (window && window.around) q.set('around', window.around)
                if (window && window.before) q.set('before', window.before)
                if (window && window.after) q.set('after', window.after)
                const r = await fetch(`${base}/${conversationId}?${q}`)
                // → { messages, participants, cursorOlder?, cursorNewer?, atStart?, atEnd? }
                return await r.json()
            },

            subscribe(conversationId, handlers) {
                const es = new EventSource(`${base}/${conversationId}/stream`)
                es.onopen = () => handlers.onConnection && handlers.onConnection(true)
                es.onerror = () => handlers.onConnection && handlers.onConnection(false)
                es.onmessage = (e) => {
                    const evt = JSON.parse(e.data)
                    if (evt.type === 'message') handlers.onMessage(evt.message)
                    if (evt.type === 'part') handlers.onMessagePart(evt.id, evt.part)
                    if (evt.type === 'typing') handlers.onTyping(evt.participantId, evt.on)
                    if (evt.type === 'receipt') handlers.onReceipt(evt.messageId, evt.status)
                }
                return () => es.close()
            },

            // ---- optional (delete what your backend doesn't support) ---------
            async send(conversationId, draft) {
                const r = await fetch(`${base}/${conversationId}`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(draft)
                })
                return await r.json()   // ack: { id, ts, conversationId? }
            },

            async react(conversationId, messageId, emoji) {
                await fetch(`${base}/${conversationId}/messages/${messageId}/react`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ emoji })
                })
            },

            async setTyping(conversationId, on) {
                navigator.sendBeacon(`${base}/${conversationId}/typing`, JSON.stringify({ on }))
            },

            async markRead(conversationId, upToId) {
                navigator.sendBeacon(`${base}/${conversationId}/read`, JSON.stringify({ upToId }))
            }
        }
    })
})
