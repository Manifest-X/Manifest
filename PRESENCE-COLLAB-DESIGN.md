# Presence & Collaboration — design RFC

Status: **draft / in progress** (2026-06-29). Working notes for the split of the
old table-DB "presence" spike into two cleanly-separated capabilities. Not a
public doc; for our own review/editing.

## TL;DR

The original `manifest.appwrite.presence.js` spike conflated two different jobs
into one Appwrite-table mechanism. We split them by **frequency / durability /
merge-semantics**:

| | **`$presence`** (status) | **Collab** (co-editing) |
|---|---|---|
| Backend | native **Appwrite Presences** | **Cloudflare Durable Object + CRDT (Yjs)** |
| Hosting | the project's **BYO Appwrite** | **Manifest-MCP-hosted** (paid, sibling Worker) |
| Data | opaque app-defined `status` + `metadata`, TTL'd | the document + cursors/selections (awareness) |
| Frequency | a few changes/min (heartbeat ~seconds) | many/sec |
| Loss | tolerable (ephemeral) | must converge + persist |
| Merge | last-write-wins | conflict resolution (CRDT) |

Rule of thumb for the dividing line: **"If losing an update is fine and it
changes a few times a minute, it's Presence. If it must merge and changes many
times a second, it's collab."**

The old table-row cursor/selection code does **not** move into Presences — it
moves into the collab awareness channel. The legacy `data/presence/*` subscripts
are kept for salvage, not shipped.

## Why not keep it all on Appwrite tables

Every cursor update was an `updateRow` — a durable MariaDB write, indexed, then
swept as stale, plus realtime fan-out. For data worthless 300 ms later that's
pure write-amplification; Appwrite Cloud meters DB ops + realtime messages +
bandwidth, so cursor streaming would dominate the bill and blow quotas (and the
self-host realtime path has known reliability gaps — appwrite/appwrite#10923).
Appwrite is right for durable data (auth/data/files) and Presences is right for
coarse status; neither is the substrate for high-frequency co-editing.

## Layer 1 — `$presence` (Appwrite Presences)

A general **awareness primitive**, not Playcom's `online/away/offline`
specifically. Carries an opaque app-defined `status` string + arbitrary
`metadata` JSON; imposes no vocabulary. Good for: online/away/idle, "viewing
route X" (`metadata.route`), soft locks / "editing record 42", coarse "typing in
conversation X", rosters/attendance, last-seen, custom user state (DND, emoji,
task).

SDK (appwrite-web 26.x, verified live): `new Presences(client)` →
`list / get / upsert / update / delete`; `Channel.presences()` → `"presences"`,
`Channel.presence(userId)` → `"presences.<id>"`; `Role.team/user/users`,
`Permission.read`, `ID`. Records carry server-managed `expiresAt` (TTL) refreshed
by re-upsert.

Plugin: `src/scripts/manifest.appwrite.presences.js` (note plural, matches the
Appwrite product; distinct from the legacy singular cursor file). Exposes the
`$presence` Alpine magic, backed by `Alpine.store('presence')` for reactivity.

- `$presence.start(opts?)` — build client from manifest appwrite config, hydrate
  via `presences.list()`, subscribe to `Channel.presences()`, begin heartbeat,
  wire focus/blur auto-flip, and auto-clear on sign-out.
- `$presence.set(status, metadata?)` — `presences.upsert({ presenceId: userId,
  status, metadata, permissions })`. Read perms: `Role.team(currentTeam)` if a
  team is active, else `Role.users()` (Playcom's request, generalised).
- `$presence.of(userId)` — reactive `{ status, metadata, lastSeen }` or null.
- `$presence.all` / `list()` — reactive roster `[{ userId, status, metadata,
  lastSeen }]`.
- `$presence.clear()` — `presences.delete({ presenceId: userId })`.

Open nuances: presence is keyed per-user (`presenceId = userId`) so multiple
tabs/sessions of one user collapse to one roster row (last write wins). If we
need per-session presence, switch to `ID.unique()` and de-dupe by `userId` in
`all`. Heartbeat cadence vs. server TTL to be tuned once we see the default.

## Layer 2 — Collab (Durable Object + CRDT), Manifest-MCP-hosted

**Sibling Worker** `manifest-collab` (decided), sharing the MCP **D1 control
plane** (`projects`, `site_hostnames`) and **R2** — modelled on `manifest-host`.
Kept separate from `manifest-mcp` because the WebSocket/DO load profile and
deploy cadence differ from the MCP tool surface.

- **One DO per `(project_id, docId)`** room. Holds the authoritative **Yjs** doc
  in memory + the awareness channel (cursors/selections ride the same socket,
  never persisted). WebSocket Hibernation keeps idle rooms cheap. CRDT gives
  conflict resolution for free; snapshots are periodic compaction of the update
  log.
- **Snapshot home is tiered** (so customers own their data):
  - auth'd project → the project's **own Appwrite storage** (`collab/<docId>.bin`).
  - no-auth project → **Manifest R2 / DO storage**.
  On cold start the DO rehydrates from the last snapshot.

### Identity — the DO does **not** own auth; it *verifies an attestation*

The control plane already resolves `hostname → project_id` at the edge
(`site_hostnames`) and the `projects` row stores the customer's own
`appwrite_project_id` (+ planned scoped `appwrite_oauth_token_encrypted`). Tiers,
in priority order:

1. **Appwrite-auth projects (common).** Client calls `account.createJWT()` and
   presents it on WebSocket open. DO resolves `project_id → appwrite_project_id
   (+ endpoint)` from D1 and **validates the JWT against the project's own
   Appwrite** (`GET /account` with `X-Appwrite-Project` + `X-Appwrite-JWT`).
   Identity = that Appwrite user. *(Control-plane add: store the project's
   Appwrite **endpoint** at publish, read from their manifest.json, so we never
   trust a client-sent endpoint — matters for self-hosters like Playcom.)*
2. **No-auth / anonymous projects.** `manifest-host` (knows `project_id` at the
   edge) mints a short-lived, **room-scoped guest token** signed by Manifest.
   Ephemeral id + chosen display name; access is **capability-based** (hold the
   room/share link), not user-based.
3. **Custom IdP (later).** Project registers a verification key (encrypted, like
   the managed-payments secrets); collab accepts a project-issued signed token
   `{ userId, displayName, claims }`.

**Validation is on-connect** (pin identity to the connection) + a short DO-side
TTL — confirmed acceptable. A revoked session lingers until reconnect.

### Responsibility boundary (the important line)

> **Identity + durable app data = the project's domain** (collab delegates to /
> verifies it). **Realtime transport + CRDT merge + ephemeral awareness + the
> collab-doc snapshot = Manifest's domain.**

Collab never proxies the project's DB/storage writes. Durable app writes stay
client-side through the project's own Appwrite SDK under the end-user's session,
so the project's existing `Role.user/team` permissions govern access — Manifest
needs no write authority over customer data. The only thing collab persists is
the CRDT doc's own snapshot (home per the tier above).

### Commercial shape

Slots into the existing managed surface (domains / publishing / hosting → now
collab), CF-native, Polar-billed, gated per `project_id` + plan via
`config/tiers.ts`, usage logged — exactly the managed-payments pattern
(`payment_configs` encrypted per-project secrets + `payment_entitlements`).
DO-per-project gives tenant isolation for free.

## Prototype plan

First spike de-risks the **identity + transport seam**, not the editor (CRDT is
a solved library):

`manifest-collab` DO + a `manifest-host`-served page that:
1. opens a WebSocket with an Appwrite JWT,
2. DO resolves `project_id → appwrite_project_id/endpoint` from D1 and validates
   the JWT against that project's Appwrite (incl. self-hosted),
3. joins room `(project_id, docId)`, runs **Yjs awareness + a toy shared doc**,
4. snapshots to the project's Appwrite (and R2 for the no-auth path).

Proves: hostname→project resolution, per-project (incl. self-hosted) JWT
validation, DO hibernation/lifecycle, Yjs awareness+sync, snapshot round-trip.
Editor bindings (ProseMirror/CodeMirror) + the custom-IdP tier come after.

## Status of the work

- [x] Decisions: split, sibling Worker, validate-on-connect, tiered snapshot home.
- [x] `$presence` plugin (Appwrite Presences) — `src/scripts/manifest.appwrite.presences.js`.
- [x] `/presence` test harness exercises sim + a `$presence` live card.
- [ ] `manifest-collab` sibling Worker (NOT started — infra/deploy, do with Andrew present).
- [ ] Control-plane: store project Appwrite endpoint at publish.
- [ ] Retire/migrate legacy cursor code into the collab awareness channel.
