# Guest migration function

Carry a **guest's teams** over to the account they sign into, and garbage-collect
abandoned guests. Deploy as a single [Appwrite Function](https://appwrite.io/docs/products/functions)
in your own project.

## Why a function (and not the browser)

Appwrite **cannot convert an anonymous account via email OTP** — a guest who signs
in with OTP becomes a *different* user, so their teams (owned by the anonymous
account) are orphaned. (Magic-link and OAuth *can* convert in place; the Manifest
auth plugin already does that via `auth.guestUpgrade`. OTP cannot — verified.)

Reassigning a team from one user to another is privileged (server API key only),
so it lives here. The mechanic is the one validated against a live project: add the
new user to each of the guest's teams with the guest's roles (server-side
membership is auto-confirmed — no invite email), remove the guest, delete it. Team
prefs/roles/data are untouched, so anything team-scoped carries over intact.

## Endpoints

| Method · path | Who calls it | Body | Returns |
|---|---|---|---|
| `POST /prepare` | the **guest** (anonymous session) | — | `{ ok, ticket, teams:[teamId…] }` |
| `POST /commit`  | the **new** account, just after sign-in | `{ ticket }` | `{ ok, migrated:[teamId…], guestDeleted }` |
| `POST /gc`      | the function **schedule** (or a keyed trigger) | — | `{ ok, scanned, deletedUsers, deletedTeams }` |

The auth plugin drives `prepare` (while still a guest) and `commit` (after sign-in)
automatically when `auth.guestMigration` is configured — you don't call these by hand.

## Security model

The hard part is proving, at `commit`, that the new caller is the same person who
held the guest session. We use a short-lived **HMAC-signed ticket**:

1. `prepare` is callable **only by the authenticated guest** (caller is read from
   Appwrite's forwarded `x-appwrite-user-id`; the function checks it's an anonymous
   account). It returns a ticket binding that exact guest id + its team set.
2. `commit` is callable **only by the signed-in new account**. It verifies the
   ticket's signature + expiry, refuses if the caller *is* the guest, then migrates
   only the teams named in the ticket.

A ticket can't be forged (HMAC) or aimed at someone else's teams (bound to a guest
id + team list) and expires fast (`MIGRATION_TICKET_TTL`, default 10 min).

## Deploy

1. Create the function (Node 18+ runtime). Entrypoint `src/main.js`, build command
   `npm install`. In the create dialog, choose **"Connect later"** unless this folder
   already lives in a Git repo you want Appwrite to track (then set the function's
   **Root directory** to this folder). With "Connect later", deploy from this folder:
   ```sh
   appwrite functions create-deployment \
     --function-id <id> --entrypoint 'src/main.js' \
     --code . --activate true
   ```
2. **Grant the API scopes** — two ways, pick one:
   - **Dynamic key (recommended, newer Appwrite):** in the function's **Scopes**, enable
     `users.read`, `users.write`, `teams.read`, `teams.write`. Appwrite injects a
     per-execution key (`x-appwrite-key`) the function uses automatically — nothing to
     store. (Appwrite has no `memberships.*` scope; membership ops live under `teams.*`.)
   - **Static key:** create an **API key** with those same scopes and set it as the
     `APPWRITE_API_KEY` env var below.
3. Set env vars:
   | var | purpose |
   |---|---|
   | `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT` | server client target |
   | `APPWRITE_API_KEY` | only if you chose the static-key path in step 2 |
   | `MIGRATION_TICKET_SECRET` | random secret for ticket HMAC (server-only) |
   | `MIGRATION_TICKET_TTL` | ticket lifetime, seconds (default `600`) |
   | `GUEST_GC_COOLDOWN_DAYS` | abandon-after window for GC (default `30`) |
   | `GUEST_GC_KEY` | optional shared secret to trigger `/gc` via `x-guest-gc-key` |
4. Set **Execute access** to `users` (and `guests` if you allow anonymous sessions) —
   **not** "Public". `prepare`/`commit` rely on the caller's authenticated identity, so
   there's no reason to expose execution to unauthenticated bots.
5. For GC, add a **schedule** (CRON, e.g. daily `0 3 * * *`). Scheduled runs hit
   `/gc` with `x-appwrite-trigger: schedule`; no key needed.

## Client wiring

Point the auth plugin at this function in `manifest.json`:
```json
{ "appwrite": { "auth": { "methods": ["guest-manual","otp","oauth"],
  "teams": { "permanent": ["Workspace"], "guests": true },
  "guestMigration": { "functionId": "<your function id>" } } } }
```
With that set, after a guest signs in (via OTP, or OAuth landing on a different
account) the plugin redeems the ticket and the guest's teams follow them. No markup
changes.

> `guestMigration` is the OTP-friendly counterpart to `guestUpgrade`: `guestUpgrade`
> preserves the account in place (magic/OAuth only); `guestMigration` reassigns teams
> to a brand-new account (works for OTP, the common case for OAuth+OTP projects).
