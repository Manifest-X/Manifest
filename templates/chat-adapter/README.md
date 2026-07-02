# Chat Adapter Guide

How to connect the Manifest chat plugin to any backend — your own API, an Appwrite database, a messaging platform, or an LLM.

The plugin owns the frontend: a reactive conversation (messages, participants, typing) that authors render with plain HTML, plus the interaction intents (send, react, page, transfer). **An adapter owns everything behind it: storage, transport, and delivery.** The plugin never talks to a network itself — it calls your adapter, and your adapter talks to your backend.

`adapter.js` in this folder is a commented skeleton to copy. The built-in adapters are working references: `src/scripts/chat/manifest.chat.adapters.js` (in-memory `demo` + an aggregate variant) and `manifest.chat.adapters.llm.js` (`claude`, streaming over SSE).

---

## Quickstart

Register a factory under a name, then authors open conversations with it:

```js
document.addEventListener('alpine:init', () => {
    window.ManifestChatAdapters.register('mybackend', (opts) => ({
        identity: () => ({ id: 'u1', kind: 'human', displayName: 'Me' }),

        async load(conversationId, window) {
            const r = await fetch(`/api/chats/${conversationId}`)
            return await r.json()          // { messages, participants }
        },

        subscribe(conversationId, handlers) {
            const es = new EventSource(`/api/chats/${conversationId}/stream`)
            es.onmessage = (e) => handlers.onMessage(JSON.parse(e.data))
            return () => es.close()        // unsubscribe
        },

        async send(conversationId, draft) {
            const r = await fetch(`/api/chats/${conversationId}`, {
                method: 'POST', body: JSON.stringify(draft)
            })
            return await r.json()          // ack: { id, ts }
        }
    }))
})
```

```html
<div x-data="{ c: $chat.open('room-1', { adapter: 'mybackend' }) }">…</div>
```

`identity`, `load`, and `subscribe` are required. Everything else is optional — the handle's `can.*` flags reflect exactly what you implement, so authors can hide affordances your backend doesn't support. A read-only transcript is an adapter with no `send`.

---

## Data shapes

The plugin normalizes whatever your backend speaks into these frontend shapes. Map at the adapter boundary; don't reshape your backend.

### Participant

```js
{
    id,              // unique within the conversation's participant space
    kind,            // 'human' | 'agent' (an AI) | 'contact' (an end-user) | 'system'
    role,            // free string: 'owner', 'assignee', 'bot', … — project-defined
    displayName,
    avatar,          // url, optional
    color,           // optional; used by renderers for author coloring
    presence         // optional: 'online' | 'idle' | 'offline'
}
```

`kind` is how AI and people coexist without special cases: an assistant is just a participant with `kind: 'agent'`.

### Message

```js
{
    id,              // unique; the plugin dedups by id across load() and subscribe()
    conversationId,
    author,          // Participant (see the author invariant below)
    body: {
        text,        // raw text, exactly as written — never pre-rendered, never pre-translated
        media,       // optional [{ kind: 'image'|'document', url, mediaType, name, … }] — URLs only
        blocks,      // optional rich blocks
        actions      // optional [{ id, label }] — buttons; clicking emits an intent
    },
    replyTo,         // optional parent message id — enables the reply tree
    ts,              // sortable timestamp — ALWAYS adapter-supplied, never minted client-side
    status,          // 'pending' | 'streaming' | 'sent' | 'delivered' | 'read' | 'failed'
                     //   plus 'edited' | 'retracted'; optional statusReason on 'failed'
    reactions,       // optional [{ emoji, count, byMe, by? }] — `by` (who) may load lazily
    meta             // opaque passthrough: channel, externalId, raw, authoredBy, audience, …
}
```

Invariants adapters must hold:

- **`author` is the display identity** — what the reader should see (and what decides bubble side). If a human sends *as* a bot, `author` is the bot; put the true author in `meta.authoredBy`.
- **`ts` ordering is your authority.** The plugin sorts by `ts` (id as tiebreak). Don't let clients mint timestamps.
- **`body.text` stays raw.** Markdown, translation, and sanitization are render-time, author-owned concerns.
- **The plugin is audience-agnostic.** Internal notes or whispers ride `meta.audience`; filtering is the renderer's job. Never assume every message in `messages` is end-user-visible.

---

## The contract

### Required

| Method | Returns | Notes |
|---|---|---|
| `identity()` | Participant | Who "I" am. Drives own-message detection (`handle.me`) and optimistic echoes. |
| `load(conversationId, window?)` | `{ messages, participants, cursorOlder?, cursorNewer?, atStart?, atEnd? }` | One page of history. `window` may carry `{ around, before, after, limit }` — see Paging. |
| `subscribe(conversationId, handlers)` | unsubscribe `fn` | Live inbound. Call the handlers below as events arrive. |

`subscribe` handlers — call the ones you have events for:

| Handler | When |
|---|---|
| `onMessage(msg)` | A new or updated message (status changes, edits, server echoes). Upserted by id. |
| `onMessagePart(id, { text, done? })` | A streaming chunk appends to message `id`'s text. `done: true` closes the stream. |
| `onParticipant(p, op)` | `op` is `'added' | 'removed' | 'changed'`. |
| `onTyping(participantId, bool)` | Typing started/stopped. |
| `onReceipt(messageId, status)` | Delivery/read ticks — cheaper than re-emitting whole messages. |
| `onReaction(messageId, reactions)` | The message's full reactions array changed. |
| `onConnection(bool)` | Drives `handle.live` — the renderer shows "reconnecting…" while false. |
| `onGap(hint?)` | "You missed messages" — see Reconnection. |

### Optional (each unlocks a `can.*` flag)

| Method | Flag | Notes |
|---|---|---|
| `send(conversationId, draft)` | `can.send` | Return an ack `{ id, ts, conversationId? }`. See Optimistic sends. |
| `edit(conversationId, id, body)` | `can.edit` | |
| `retract(conversationId, id)` | `can.retract` | Mark the message `retracted` via `onMessage`; don't silently delete. |
| `react(conversationId, id, emoji)` | `can.react` | Toggle semantics recommended: off if mine, join if others', add if new. |
| `setTyping(conversationId, bool)` | `can.typingIndicators` | |
| `markRead(conversationId, upToId)` | `can.readReceipts` | Read state is **adapter-supplied only** — the plugin never computes unread counts. |
| `addParticipant(conversationId, p)` / `removeParticipant(conversationId, id)` | `can.addParticipants` | |
| `transfer(conversationId, from, to, role?)` | `can.transfer` | You own the rules; the plugin emits the intent and reflects resulting state. |
| `loadReplies(conversationId, parentId, cursor?)` | `can.loadReplies` | Paginate a busy subtree's direct children. |
| `loadReactions(conversationId, messageId)` | `can.loadReactions` | Lazy who-reacted attribution. |

Handle-level `can.*` means "the affordance exists" — per-message rules (edit only my own, can't retract a delivered message) are computed by the app, or enforced by your backend.

---

## Streaming

A streaming reply (an LLM, a partial delivery) is one message assembled in place:

1. Emit `onMessage({ id, …, body: { text: '' }, status: 'streaming' })`.
2. Emit `onMessagePart(id, { text: chunk })` per chunk — the plugin appends and re-renders.
3. Emit `onMessagePart(id, { text: '', done: true })` — status settles to `sent`.

The renderer binds to the same message throughout; no special markup needed.

---

## Optimistic sends

When the author calls `handle.send(draft)`, the plugin:

1. Inserts a local echo immediately — temp id, `status: 'pending'`, sorted at the tail (no `ts` yet).
2. Calls your `send`. On the ack it swaps in the real `{ id, ts }` and re-sorts.
3. On failure it marks the echo `failed` (with `statusReason`) — never silently drops it.

Two things your side must honor:

- **Body/media reconcile via the server echo, not the ack.** The ack carries only ids. Echo the sender's own message back over `subscribe` (`onMessage` upserts by id) so a locally-shown attachment swaps to its canonical URL. A bus that doesn't echo the sender strands local state.
- **`ack.conversationId` re-homes.** If a reply into a closed conversation spawns a new one server-side, return the new id in the ack. In an aggregate handle the new conversation joins the stream natively; a single-conversation handle does **not** auto-retarget — it exposes `handle.lastRehome = { from, to }` and the app must re-open on `to` before the next send. If closed-thread replies are common in your product, route them through an aggregate handle.

---

## Paging

`load` is anchored and bidirectional. The `window` argument may carry:

| Field | Meaning |
|---|---|
| `around: messageId` | Open centered on a message (deep links, jump-to). |
| `before: cursor` / `after: cursor` | Page older / newer from a boundary. |
| `limit` | Page size hint. |

Return opaque `cursorOlder` / `cursorNewer` plus `atStart` / `atEnd` booleans — cursors can encode anything (offsets, snowflakes, a hot-log→archive boundary). The handle exposes `loadOlder()` / `loadNewer()` and the flags drive "load more" affordances.

**The subtlest seam: forward paging meets the live tail.** When a handle opened in the past pages newer toward the present, the boundary between the last paged message and the first live message is where a naive adapter double-renders or gaps. The plugin dedups by id — make sure the ids on both paths (history reads and live pushes) are the same ids, and flip `atEnd` when the page reaches "now".

---

## Reconnection

You own the connection. On a drop: emit `onConnection(false)`; on recovery either **re-emit a recent window** (the plugin dedups by id) or emit **`onGap({ since })`** — the plugin then backfills with a scoped `load` instead of reloading everything newer. `since` can be a cursor or timestamp; bound it to the last state you know the client saw. This matters most for the laptop-closed-for-hours case on a busy conversation.

---

## Aggregate conversations (virtual ids)

A `conversationId` doesn't have to be one backend conversation. An adapter may treat an id like `agg:contact-7` as a **merged view** — one archive query across many conversations plus live subscriptions to the open ones. Rules the plugin already handles, which your fan-out must feed correctly:

- `onMessage` may carry a `conversationId` the handle has never seen (a brand-new conversation spawned mid-session) — subscribe at the *contact* level, not just per-open-conversation, so it arrives.
- `participants` in aggregate mode is a derived union; renderers key off each message's `author`.
- Sends route by draft context (e.g. a reply-channel choice riding `draft.meta`), and re-homing acks are the norm rather than the exception.

Open handles with `$chat.open('agg:…', { adapter: 'yours', aggregate: true })`. For merging a *few* known conversations client-side, `$chat.merge([h1, h2])` is simpler — aggregate adapters are for when the membership itself lives server-side.

---

## What the plugin will never do

Design your adapter knowing these stay on your side of the line:

- **Persistence, retention, history storage** — yours.
- **Transport** (WebSocket/SSE/polling/webhooks) and delivery guarantees — yours.
- **Channel integrations** (WhatsApp, Telegram, email, Slack) — server-side, yours; the browser adapter talks to *your* bus, not to the channel.
- **LLM execution and keys** — a server relay's job (see `tools/chat-llm-proxy.mjs` and the `ai` block in the docs); the browser never holds a model key.
- **Auth and visibility policy** — client-side gating is cosmetic; enforce access on the backend the adapter calls.
- **Transfer/routing semantics, moderation policy, blob storage** — the plugin emits intents and renders state; the rules are yours.

Author-facing usage (rendering, the `$chat` surface, the `ai` block) is documented at [manifestx.dev/docs/core-plugins/chat](https://manifestx.dev/docs/core-plugins/chat).
