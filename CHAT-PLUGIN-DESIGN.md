# Manifest Chat Plugin — Design Doc (DRAFT / RFC v2)

> **Status: DRAFT / RFC — v2.3 (reference implementation verified).** Architecture for a `$chat` plugin, iterated across two adversarial reviews by Playcom as first power-user consumer. **Playcom has signed off: no blockers remain** — the contract expresses its three-lens default, multi-pane, transfers, and nested threading without a fork. v2.3 adds a working framework-side spike (`src/scripts/chat/`) + a driven `/chat` harness that verifies every hard part of the contract end-to-end against a static reference adapter (and surfaced one cursor-management subtlety, now fixed — see §13). The data model and adapter contract are considered settled.

---

## 0. The one-sentence boundary

**Manifest renders and drives conversations; it never transports or stores them. The plugin is the head, not the bus.**

If a proposed feature would make Manifest responsible for *where messages live*, *how they're delivered*, *who generates them*, *who may see them*, or *what they cost*, it belongs behind an adapter, not in the plugin.

The architectural parent is the **data plugin's source-adapter model** (`$x.<source>` over CSV / JSON / REST / Appwrite), **not** the presence/Appwrite subsystem. Appwrite is one optional adapter among several, never the substrate.

---

## 1. Why this shape (the design pressure)

A chat is a *shape*: **a participant set + an ordered (optionally threaded) message stream + a set of interaction intents**, presented by a renderer the author controls. Every target use case is that shape with a different adapter and rendering:

| Use case | Adapter | Participants | Rendering |
|---|---|---|---|
| AI co-pilot, many sessions | LLM/MCP adapter | user + agent | full-page, flat |
| Messaging-app bot (WhatsApp/Telegram) | channel adapter (server) | contact + agent/human | operator-side |
| Forum / social posts + replies | data/REST adapter | many humans | tree (cards + nested replies) |
| CX helpdesk, live duplex | bus adapter (e.g. Playcom DO) | contact + agent(s) + human(s) | cockpit, flat, multi-pane |
| Cross-channel / aggregate history | aggregate adapter (virtual id, §3) | all, mostly read | one merged timeline, anchored |
| Transcript viewer (read-only) | history/archive adapter | all, read-only | flat, no composer |

The test that the abstraction is right: **AI-vs-human, DM-vs-group, widget-vs-page-vs-forum are never configuration branches.** They are participant `kind`, participant count, and rendering.

---

## 2. Data model

Three reactive shapes — the **frontend contract**. An adapter maps a project's native model (e.g. Playcom's Canonical Message) onto these at the boundary.

```js
// Participant — AI vs human vs channel endpoint is just `kind`.
{
  id,
  kind,          // 'human' | 'agent' | 'contact' | 'system'  (open string; renderer decides)
  role,          // free string: 'owner' | 'assignee' | 'observer' | 'bot' | …  (project-defined)
  displayName, avatar, color,   // color optional, deterministic if omitted
  presence,      // optional: 'online'|'idle'|'offline'|'typing'|'viewing'  (capability-gated, §5)
  isMe           // resolved against adapter.identity()
}

// Message
{
  id,
  conversationId,  // the BACKEND conversation this message belongs to. MAY differ from a
                   //   handle's (virtual/composite) id, and MAY CHANGE on send-ack (§3) when a
                   //   reply spawns a new conversation. Never assume one handle == one backend id.
  author,          // Participant ref = the DISPLAY identity (decides bubble side / attribution shown
                   //   to the other side). TRUE authorship (send-on-behalf, takeover) → meta.authoredBy.
  body: {
    text,          // ALWAYS the original. Adapters MUST NOT pre-translate (see Invariants).
    blocks,        // optional rich blocks
    media,         // optional [{ id, kind, url, … }] — URLs only; the plugin never owns blobs
    actions        // optional [{ id, label, … }] — buttons/quick-replies; click emits an intent
  },
  reactions,       // optional [{ emoji, count, byMe, by? }] — display only; `by` (reactor ids) is
                   //   optional/lazy via loadReactions?() (§3); react?()/unreact?() are capability-gated
  replyTo,         // optional parent message id → the thread tree, ANY depth (render-time, §4.2)
  rootId,          // optional thread-root id (top of the reply tree); supplied by adapters that
                   //   thread server-side, else derived by following replyTo. Aids grouped renders.
  replyCount,      // optional count of DIRECT children — drives "show N replies" without loading them
  ts,              // sortable timestamp; SUPPLIED by the adapter, never minted by the plugin
  status,          // 'pending'|'streaming'|'sent'|'delivered'|'read'|'failed'|'retracted'|'deleted'
  statusReason,    // optional: disambiguates 'failed' → 'send' | 'delivery' | <adapter string>
  edited,          // optional
  meta             // opaque passthrough + recommended conventions (below)
}

// Conversation handle — the reactive projection the renderer binds to (§4).
```

**`meta` recommended conventions** (so independent adapters agree on keys; the plugin treats all as opaque):
`authoredBy` (true author when `author` is a display identity) · `audience` (visibility scope: whisper / internal-note / shadow-draft) · `deliveryStatus` (channel-granular lifecycle, e.g. email Pending→Delivered) · `lang` (source language) · `channel` · `externalId` · `direction` · `raw`.

**Invariants** (the plugin guarantees these; adapters must honor them):
- **`direction` (in/out) is derived, not authoritative** — `author.isMe` / `author.kind === 'contact'` decides side at render time. (Group chat with N of our own identities isn't a left/right binary; it's participant + color.)
- **`author` is the display identity**, not necessarily the true author. True authorship rides `meta.authoredBy`. An adapter that sets `author` to the true human breaks bubble-side and player-facing attribution.
- **Adapters MUST NOT pre-translate `body.text`.** Translation is render-time and cockpit-owned (`meta.lang` = source); the renderer translates off its own cache. Guarantees a stable original for audit/history.
- **The plugin is audience-agnostic.** It never filters or computes aggregates (last-message preview, counts, unread) over `c.messages` by visibility. Audience scoping rides `meta.audience`; filtering is the renderer's/adapter's job.
- **`ts` and message identity belong to the adapter.** The plugin orders and dedups by them; it never generates them. (Manifest scripts can't call `Date.now()` deterministically anyway.)
- **`media` carries URLs only.** Storage, signing, virus-scan, retention are the project's job.

---

## 3. The adapter contract (the entire seam)

A plain object. The plugin **feature-detects** which methods exist and exposes matching capability flags; absent methods mean the affordance isn't rendered.

```js
const adapter = {
  // ── Required ───────────────────────────────────────────────────────────────
  identity()                          -> Participant,           // "me"

  load(conversationId, window?)       -> { messages, participants, cursorOlder, cursorNewer, atStart, atEnd },
    // window = { around?: messageId, before?: cursor, after?: cursor, limit? }
    // ANCHORED + BIDIRECTIONAL: open in the middle of a long history and page BOTH ways
    //   (deep-links, jump-to-search, jump-to-event). Backward-only paging is insufficient.
    // load/subscribe MAY FAN OUT across many backend streams internally. The plugin makes NO
    //   assumption that conversationId == one backend conversation == one subscription. messages
    //   and participants may even arrive from different authorities/transports (e.g. a live
    //   message socket + a control-plane roster source) — the adapter multiplexes; the plugin
    //   sees one unified stream.

  subscribe(conversationId, handlers) -> unsubscribe,           // realtime in
    // handlers: onMessage(msg) · onMessagePart(id, part) · onParticipant(p, op) ·
    //           onTyping(pid, bool) · onReceipt(msgId, status) · onGap(hint?)
    // onMessage MAY carry a conversationId never seen in any loaded window: in an aggregate handle a
    //   new inbound can spawn a brand-new backend conversation (closed-never-reopens). The plugin
    //   places it by ts/id and NEVER rejects it as "unknown" — the aggregate adapter must subscribe
    //   at the CONTACT level (not just per-open-chat) for this to arrive live.
    // RECONNECT is the adapter's responsibility. On reconnect it either re-emits a recent window
    //   (plugin dedups by id, §6) OR calls onGap(hint?) — hint = { since?: cursor|ts, until? } — so the
    //   plugin scopes the backfill load() to [lastSeen, now] instead of reloading everything newer.
    //   The adapter drives connection state → c.live / c.connected.

  // ── Optional (each gates a capability flag) ────────────────────────────────
  send?(conversationId, draft)        -> ack { id, ts, conversationId? },   // → can.send
    // draft may carry opaque { asParticipantId, viaChannelId } — NOT required to be in
    //   participants[] (an alias you send as may not yet be a thread participant; validated
    //   server-side). ack.conversationId lets an optimistic send reconcile into a DIFFERENT/NEW
    //   conversation (reply into a closed thread that spawns a fresh one).
  edit?(conversationId, id, body)     -> ack,                   // → can.edit
  retract?(conversationId, id)        -> ack,                   // → can.retract  (sets status 'retracted')
  react?(conversationId, id, emoji)   -> ack,                   // → can.react
  unreact?(conversationId, id, emoji) -> ack,
  loadReplies?(conversationId, parentId, cursor?) -> { messages, cursor, done },  // → can.loadReplies
    // paginate the DIRECT children of a message — for busy subtrees (forum/social "show N more
    //   replies"). Replying itself is just send(draft) with draft.replyTo set; no separate intent.
  loadReactions?(conversationId, messageId) -> [{ emoji, by: [participantId] }],  // → can.loadReactions
    // lazy reactor attribution (who reacted — an audit/CX signal) without bloating the default shape.
  addParticipant?(conversationId, p)  -> ack,                   // → can.addParticipants
  removeParticipant?(conversationId, id) -> ack,
  transfer?(conversationId, fromId, toId, role?) -> ack,        // → can.transfer
  setTyping?(conversationId, bool),                             // → can.typingIndicators
  markRead?(conversationId, upToId),                            // → can.readReceipts  (write-intent only; §5)

  capabilities?: { … }   // optional explicit override of feature-detection
}
```

**Intentional redundancy (not accidental surface):** `onReceipt` is kept distinct from `onMessage`-with-updated-status because read/delivery ticks are high-frequency and a dedicated channel is far lighter than re-emitting whole messages. `addParticipant`/`removeParticipant` are kept distinct from `transfer` because adding a person to a group and handing off a role are different *atomic* intents, even though both mutate `participants[]`.

This one mechanism covers the hard cases **without config forks**: read-only transcript = `identity`+`load`+`subscribe` only (`can.send === false`, no composer drawn); AI streaming = `onMessagePart` assembling a `status:'streaming'` message; full duplex + transfer = the optional intents implemented, plugin reflects state, project's rails decide rules.

---

## 4. Author-facing surface (`$chat`)

Instance-oriented, like mounting a data source. **No global "the chat" config in `manifest.json`** — a project runs many paradigms at once (co-pilot + helpdesk + transcript), so conversations open at the point of use. `manifest.json` *optionally* registers named adapters (as data sources are registered).

```js
const c = $chat.open(conversationId, { adapter: 'playcom', around: messageId? , …opts })
```

The handle (reactive; bind with `x-for` / `x-text`):

```js
c.messages          // flat ordered array — always present; the base for flat renders
c.tree(opts?)       // derived nested projection over .replyTo; opts.maxDepth bounds nesting (§4.2)
c.participants      // array
c.me                // Participant
c.typing            // [Participant] currently typing
c.status            // 'idle'|'loading'|'ready'|'error'   — lifecycle of the initial load
c.live              // bool — realtime currently connected (distinct from status: a handle is
                    //   often 'ready' (stale) AND reconnecting; render a quiet "reconnecting…" off this)
c.atStart / c.atEnd // reached the ends of history in each direction (drives "load more" affordances)
c.lastRehome        // reactive { from, to } | null — last send-ack that re-homed the message into a
                    //   DIFFERENT conversation (closed→new-Chat). A single-chat handle does NOT auto-
                    //   retarget; the cockpit must re-open on `to` before the next send (§6).
c.can               // { send, edit, retract, react, transfer, addParticipants, typingIndicators,
                    //   readReceipts, loadOlder, loadNewer, loadReplies, loadReactions }
                    //   NB: can.* means the affordance EXISTS, not that every message is actionable.
                    //   Per-message/per-rails actability (edit only my own · can't retract a delivered
                    //   message · can't touch an archived one) is cockpit-computed, not a plugin flag.

c.loadOlder() / c.loadNewer()   // page either direction from the current window
c.loadReplies(parentId)         // page a message's direct children (lazy subtrees, §4.2)
c.loadReactions(messageId)      // lazy reactor attribution (who reacted), if can.loadReactions
c.send(draft)                   // optimistic; resolves on ack (may re-home via ack.conversationId)
c.edit(id, body) / c.retract(id) / c.react(id, emoji) / c.unreact(id, emoji)
c.setTyping(bool)
c.markRead(upToId)              // write-intent to the bus; read-state reflected from adapter (§5)
c.addParticipant(p) / c.removeParticipant(id) / c.transfer(fromId, toId, role?)
c.close()                       // tears down the subscription (call on unmount)
```

The author writes all markup. The plugin ships **no message bubbles, no composer** (§9). Optional, clearly-replaceable starter components (`<x-chat-log>`, `<x-chat-composer>`) may ship as scaffolding-to-delete, not as the API.

### 4.1 Three distinct things that are often confused

These are *not* the same primitive — keeping them separate is what keeps the plugin thin:

- **Multi-pane = N independent handles.** "N conversations side-by-side" is N separate `$chat.open(...)` calls rendered in N panes. **Nothing merges.** This is genuinely free — no plugin work beyond opening multiple handles.
- **Merge = one small-N read projection.** `$chat.merge([handleA, handleB, …], { order: 'ts' })` interleaves a *handful* of live handles into one stream — the right fit for a **Case lens** (a few member chats interleaved). Read-mostly; `send` routes to an explicitly chosen target source, where the `ack.conversationId` re-homing matters.
- **Aggregate lens = one handle over a virtual/composite `conversationId`.** The big cross-channel "entire history" view (potentially hundreds of mostly-closed conversations) is **not** a merge of N live handles — that would imply N subscriptions. It is a *single handle* whose adapter fans out internally: one cross-conversation archive query for history + live subscriptions only for the handful of open conversations currently in the window. This is exactly why §3 blesses **virtual `conversationId` + anchored bidirectional `load` + `ack.conversationId`**. The aggregate adapter is the project's to own (it's entangled with identity resolution and the hot/archive split), and the plugin treats its virtual id like any other. Two aggregate-mode edges: **`c.participants` is a derived *union*** across all member conversations — per-conversation role/status isn't meaningful at the handle level, so rendering derives bubble-side from each message's `author`, not from the roster — and the adapter must subscribe at the **contact level** (not just per-open-chat) so a brand-new conversation's first inbound arrives live (§3: `onMessage` may introduce an unseen `conversationId`).

### 4.2 Threading & nesting (optional · flat · bounded · unbounded)

Nesting is a **render-time projection over `replyTo`**, never a data constraint or an adapter requirement. The flat chronological `c.messages` is always present; threading is opt-in on top. A message points at its parent; depth is emergent, so the data model needs no notion of "levels."

- **`c.tree(opts?)`** — reactive derived projection: top-level messages as roots, each with a recursive `replies[]`, every node annotated with `depth` and `childCount`. Siblings sorted by `ts` (renderer may re-sort).
- **Choose the shape per render** — the project decides, not the contract:
  - *Flat* — ignore `c.tree`, render `c.messages` (CX cockpit, DMs).
  - *Bounded to N levels* — `c.tree({ maxDepth: N })`. Replies deeper than N still render in order with their true `depth` preserved, they just stop indenting past level N (the Reddit cap-the-indent pattern). `maxDepth: 1` = one level of replies.
  - *Unbounded* — `c.tree()` (forum / social / nested discussions).
- **Orphans handled gracefully** — a reply whose parent isn't in the loaded set (paginated away, or in a not-yet-loaded archive page) surfaces as a root with `node.orphan = true`, so the renderer can show "replying to …" without dropping the message or breaking the tree.
- **Replying is just `send`** — `c.send({ ...body, replyTo: parentId })`. No separate intent.
- **Lazy subtrees (scale)** — a busy parent carries `replyCount` and exposes more children via the optional `loadReplies?` capability (`c.loadReplies(parentId)` → `can.loadReplies`), so a thread with thousands of replies doesn't load whole. Without the capability, the tree is simply built from whatever `c.messages` holds.

Net: flat, capped, or infinite nesting by a single projection argument — and a flat-only project never pays for any of it.

---

## 5. Presence, read-state & typing

Two *different* presences, deliberately separated:
- **Conversation-scoped** — typing, who's-viewing-this-thread, collision (≥2 of our own participants with `presence:'viewing'|'typing'`). Fed by the adapter. In scope as an optional capability. The lock/collision *rule* is the project's (state reflection, like transfers).
- **Site-wide / visitor presence** — "who's on the site" boards, anonymous dwell/journey. **Out of scope** — separate, higher-cardinality concern with its own lifecycle. The join between the two (same human typing here = a dot on the visitor board) is cockpit-side, by contact id; it does not leak into the contract.

**Read-state is adapter-supplied, and that is the *only* path.** There is **no plugin-side unread computation** (no "messages since `markRead`" fallback): it could only ever be right for an open handle and wrong for the inbox list and the aggregate lens, and a half-right count is worse than none. `markRead(upToId)` is a write-intent; unread/receipts are reflected from the adapter, multi-scope (per-message receipt + per-conversation unread).

---

## 6. Streaming, reconnection & optimistic reconciliation

The genuinely hard correctness areas.

**Streaming assembly.** A message may arrive `pending` → `streaming` (with `onMessagePart` appending to `body.text`/`blocks`) → `sent`/`complete`. The renderer binds the same object throughout. Identical path for an LLM token stream and a partial channel delivery.

**Optimistic send + re-homing.** `c.send(draft)`:
1. inserts a local message with a temp id, `status:'pending'`, sorted at the **tail** until an ack supplies `ts` (a pending message has no adapter-minted timestamp yet),
2. calls `adapter.send`,
3. on `ack { id, ts, conversationId? }`, reconciles the temp message with the real id/ts — **and re-homes its `conversationId` if the ack returns a new one** (reply into a closed thread that spawned a fresh conversation); re-sorts if `ts` shifted,
4. on failure, sets `status:'failed'` with `statusReason`; never silently drops.

**Body/media reconcile from the server echo, not the ack.** `ack` carries only `{id, ts, conversationId}`. A locally-shown attachment (object-URL) swaps to its canonical URL when the bus **echoes the sent message back over `subscribe`** (`onMessage` upserts by id). This requires the bus to echo the sender's own message to the sender (a DO that broadcasts to all participants incl. sender does this natively); a bus that doesn't echo would strand the local URL — document it as an adapter requirement.

**Re-homing footgun (single-chat lens).** A single-conversation handle does **not** auto-absorb a re-homed conversation. Deep-link to closed `cht-050`, reply → spawns `cht-200`, ack re-homes the message — but the handle is still on `cht-050`, so a second quick reply spawns `cht-201`. The cockpit **must re-open/retarget on `to` before the next send**; `c.lastRehome` is the reactive signal to do so. Recommended: route closed-chat replies through the **aggregate/contact handle**, where spawn-and-absorb is native (the new conversation simply joins the live set) and this hazard doesn't exist.

**Failure granularity.** `send`-failure (no ack/id — message never left) vs `delivery`-failure (acked, then carrier/recipient failed) are distinguished by `statusReason` (`'send'` | `'delivery'` | adapter string), with channel-granular detail in `meta.deliveryStatus`. The cockpit keys different UX off them (retry-composer vs delivery-retry); the plugin's `status`-derived affordances must not assume the coarse value is sufficient.

**Reconnection / gap-backfill.** The adapter owns reconnect. On a dropped subscription it either **re-emits a recent window** (the plugin dedups by id) or fires **`onGap(hint?)`**, on which the plugin re-runs `load()` to backfill — scoped by `hint.since` (or the plugin's own last-seen cursor) to `[lastSeen, now]` rather than reloading everything newer. This bound is the must-have for an unbounded sleep-gap (laptop closed for hours on a busy conversation), where blind forward-paging from last-seen is wasteful and races the live tail. `c.live` reflects connection state so the renderer can show "reconnecting…" without implying the conversation isn't ready.

**The newer-pagination ↔ live-tail meeting point (subtlest correctness).** When a handle opens anchored in the past (`around: oldMsg`) and pages forward (`loadNewer`) toward the present, at some point `atEnd` flips and the live `subscribe` tail takes over. The boundary between the last paged-newer message and the first live message is where a naïve adapter double-renders the seam or leaves a gap. The primitives to get it right are all present — **dedup-by-id, `atEnd`, and `onGap`** — but adapter authors must explicitly reconcile this handoff; it is the single hardest point in the design.

**Ordering & dedup.** The adapter owns `ts` and identity. The store dedups by id across the realtime stream and history pages (a `load()` after a live message must not duplicate it); late-arriving history merges by id+ts.

---

## 7. Prerender / hydration

Chat is ephemeral and user-scoped, so it **no-ops in `mnfst-render` MPA output exactly like presence** — nothing to serialize. On hydration the handle re-runs `load` + `subscribe`. No prerender-specific branching in author markup.

---

## 8. Reference adapters (shipped, all optional)

1. **Static / in-memory** — seeded messages, no transport. The path for UI-first development against dummy data (e.g. Playcom Stage 1: build the whole cockpit — including anchored open and an aggregate lens over seeded multi-conversation data — before the data plane exists). High value for dev + demos. **Built & verified** — `src/scripts/chat/manifest.chat.adapters.js` (per-conversation + aggregate/fan-out views), exercised by the `/chat` harness (§13).
2. **Appwrite** — a table as the message log + Appwrite realtime for inbound; reuses the existing realtime wrapper. Turnkey for Appwrite projects.
3. **Generic transport** — `load` over GET (Manifest's GET-only remote-data constraint), `subscribe` over SSE or a custom-JS WebSocket, reconnect handled per §6. The escape hatch for any bespoke backend (the shape a Playcom DO+control-plane adapter takes — multiplexing a per-conversation socket with a control-plane roster source).
4. **LLM / MCP** *(optional, separate, on-demand-loaded like payment provider adapters)* — talks to Claude via the Manifest backend for the AI co-pilot case. Just-another-adapter; never privileged in core.

---

## 9. Non-goals (the boundary in negative space)

The plugin does **not** own, and will not grow to own:

- **The conversation LIST / inbox / work-queue.** `$chat` is **per-open-conversation only.** Queues, saved views, list rows (last-message · SLA · online-dot · unread badge) are `$x` over control-plane rows. A naïve read of "the chat plugin" invites someone to expect the list from it — it does not come from here.
- **Persistence / history / retention** — adapter/project.
- **Transport & realtime delivery, reconnection mechanics** — adapter (the plugin only defines the reconnect *contract*, §6).
- **Channel integrations** (WhatsApp/Telegram/email/Slack/Salesforce) — server-side, project-owned bus.
- **LLM execution** — prompting, token source, cost, safety — adapter/project.
- **Auth, permissions, visibility/audience policy** — project. The plugin is audience-agnostic (§2).
- **Read-state computation** — adapter-supplied only (§5).
- **Translation** — render-time, cockpit-owned; adapters never pre-translate (§2).
- **Routing / the bus / identity federation / transfer *semantics*** — project. The plugin emits intents and reflects state; it never encodes routing or handoff rules.
- **Moderation policy, blob storage, media signing/scanning.**
- **"Fire an email from a contact form."** Not chat (no ongoing thread) — form plugin + send-only adapter.

---

## 10. Open questions (post-review)

Resolved in v2 (kept for the trail):
- ~~Merge first-class?~~ → Yes but **thin**: small-N read projection only. Aggregate views use a virtual `conversationId`, not merge (§4.1).
- ~~History-vs-live boundary?~~ → Virtual `conversationId` + anchored bidirectional `load` + `ack.conversationId` (§3).
- ~~Send-as identity?~~ → Opaque `{asParticipantId, viaChannelId}` in `draft`; **not** constrained to `participants[]` (§3).
- ~~Unread authority?~~ → Adapter-supplied only; no plugin fallback (§5).
- ~~Threading depth?~~ → Recursive `replyTo` tree exposed as a render-time projection `c.tree({maxDepth})` — flat / bounded-to-N / unbounded chosen by the renderer, never a data or adapter constraint (§4.2). Optional `loadReplies` for lazy subtrees.
- ~~Reactions scope?~~ → First-class `{emoji, count, byMe, by?}` + `react?`/`unreact?` intents; reactor attribution (`by`) optional/lazy via `loadReactions?` (§3).
- ~~`onGap()` granularity?~~ → `onGap(hint?)` carries `{since?, until?}` (or the plugin's last-seen cursor) so backfill is scoped to `[lastSeen, now]` (§6).
- ~~Subtree / orphan semantics?~~ → Direct-children pagination suffices; orphan resolution stays render-only, the cockpit fetches a specific parent on demand via `load({around: parentId, limit})` — no new primitive, no auto-fetch waterfall (§4.2).

**No open design questions remain pre-implementation.** The remaining work is a reference adapter (§8) to prove the contract before a real backend adapter is written against it.

---

## 11. Notes for Playcom's own DESIGN.md (now mostly mutual)

- **Adopt the §2 shape as the cockpit's frontend contract**, map Canonical Message at the adapter boundary (`sender`→`author`, `direction`→derived, `platformMeta`→`meta`). **Pin the `author` = display-identity rule** in the mapping spec — on DM takeover, `author` = the bot's outbound identity (decides bubble side / what the player saw), `meta.authoredBy` = the true human (audit/attribution badge). Inverting this breaks rendering.
- **The aggregate player-history lens is a virtual-`conversationId` adapter you own**, not a `$chat.merge`. Distinguish, in your doc, the **live per-Chat DO socket** from the **history/archive read path** (R2 + closed chats); the default lens spans many of both. Keep `merge` for the Case lens (small N).
- **Split "presence" explicitly** into conversation-scoped (chat adapter, per-Chat DO) vs site-wide visitor presence (your separate Presence DO, out of the plugin).
- **Keep composer richness in the cockpit** (alias / reply-channel / translation / whisper / notes / AI-compose) — built over `send(draft)` + `participants` + `can.*` + your own `$x` sources. This is what prevents v3's component soup.
- **Name that `$chat` is not the inbox.** Queues/lists/saved-views = `$x` over Chat rows; `$chat` is per-open-conversation.
- **Multi-pane is free** (N independent handles); **transfers** are intent + state-reflection, your rails own the semantics.

---

## 12. Summary

Ship `$chat`: a reactive, renderable, drivable **conversation projection** + a capability-detected **adapter contract** + a few optional reference adapters. Everything about where messages live, how they move, who delivers them, who may see them, and what they cost stays behind the adapter. AI and channels are adapters and capabilities, never core branches. The v2 contract additions (virtual `conversationId`, anchored bidirectional load, re-homing send-ack, reconnect/backfill, display-vs-true author, adapter-owned read-state) are what let the single hardest real view — a cross-channel aggregate history, anchored and deep-linkable — be built *on* `$chat` rather than around it.

---

## 13. Changelog

**v2.3 — reference implementation built & verified:**
- Spiked the framework side under `src/scripts/chat/` (`manifest.chat.store.js` engine, `manifest.chat.adapters.js` static reference adapter, `manifest.chat.main.js` `$chat` magic) + a driven harness on the `/chat` route. Wired into `build.mjs`.
- Verified end-to-end against the static adapter: load/identity/participants · streaming part-assembly · optimistic send + id reconcile · **anchored bidirectional paging** (around + loadOlder/loadNewer, atStart/atEnd) · reconnect + `onGap` backfill + `c.live` · reactions/typing/addParticipant · **recursive threading** (depth 0–3 + orphan + maxDepth) · **aggregate virtual `conversationId`** fan-out across conversations · **unseen-`conversationId` live inbound** · **closed→new-Chat re-home** + `c.lastRehome`.
- **One contract-level subtlety surfaced (worth flagging to Playcom):** a directional page (`loadOlder`/`loadNewer`) returns cursors for *both* ends of its chunk, but must only advance the cursor on the side it moved — otherwise an older-page's forward cursor clobbers the live-tail cursor and forward paging silently stalls. The engine now tags ingestion with a side; adapter authors should be aware the *handle* owns which cursor is authoritative, not the page response. (This is the read-path cousin of the pagination↔live-tail seam in §6.)

**v2.2 — Playcom sign-off + punch-list (no blockers):**
- **Re-homing footgun documented** — a single-chat handle does not auto-absorb a re-homed conversation; the cockpit must retarget on **`c.lastRehome`** (new reactive observable) before the next send; closed-chat replies recommended through the aggregate handle. Added the **body/media-reconcile-from-echo** rule and pending-sorted-at-tail.
- **Aggregate live edges** — `onMessage` may introduce a previously-unseen `conversationId` (needs a contact-level new-conversation subscription); `c.participants` in aggregate mode is a derived union (per-message `author` is authoritative for rendering).
- **`onGap(hint?)`** carries `{since?, until?}` to scope backfill to `[lastSeen, now]`; documented the **newer-pagination ↔ live-tail meeting point** as the subtlest adapter correctness point.
- **Reactions** gained optional/lazy reactor attribution (`by?` + `loadReactions?`/`can.loadReactions`). **Per-message capability** clarified as cockpit-computed — handle `can.*` only means the affordance exists.
- Resolved the last three open questions (reactions / `onGap` / subtree-orphan). `onReceipt` and `addParticipant`/`removeParticipant` distinctions settled — Playcom withdrew both critiques. **Contract considered build-ready**; next step is a static/in-memory reference adapter.

**v2.1 — nested threading:**
- **Recursive replies over `replyTo` (any depth)**, exposed as a render-time projection **`c.tree({ maxDepth })`** — flat / bounded-to-N / unbounded chosen by the renderer, never a data or adapter constraint. A flat-only project pays nothing for it.
- Added optional message fields `rootId` / `replyCount`, the optional `loadReplies?` adapter capability (+ `can.loadReplies`, `c.loadReplies`) for lazy subtrees, and **orphan-reply handling** (`node.orphan`).
- Resolved the v2 open question on threading depth; opened a narrower one on subtree-loading semantics.

**v2 — incorporating Playcom's first-power-user review:**
- **Aggregate read path (the headline fix).** Blessed a **virtual/composite `conversationId`** (no 1:1 conversation⇄subscription assumption), **anchored bidirectional `load({around, before, after})`** returning both directions, and **`ack.conversationId`** so an optimistic send can re-home into a new conversation. Redefined §4.1: multi-pane (N handles) ≠ merge (small-N projection) ≠ aggregate lens (one handle, virtual id, adapter fan-out).
- **Reconnection contract** — adapter owns reconnect; `onGap()` + dedup; added `c.live`/`c.connected` distinct from `c.status`.
- **Mapping invariants** — `author` = display identity (`meta.authoredBy` = true author); adapters must not pre-translate `body.text`; plugin is audience-agnostic (no visibility filtering/aggregation); `meta` convention namespace named.
- **Status** — added `retracted`/`deleted`; `failed` disambiguated via `statusReason` (send vs delivery) + `meta.deliveryStatus` for channel-granular.
- **Read-state** — adapter-supplied only; removed any notion of plugin-side unread computation.
- **Reactions** — added as optional first-class field + `react?`/`unreact?` intents.
- **Scope clarifications** — `$chat` is per-conversation, never the inbox/work-queue list (that's `$x`); two presences split explicitly.
- **Held against feedback:** kept `onReceipt` (lighter than re-emitting messages for high-frequency ticks) and explicit `addParticipant`/`removeParticipant` (distinct atomic intents from `transfer`) despite the "over-specification" flag — the small surface buys clarity and atomicity.
