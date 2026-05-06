---
name: manifest-appwrite
description: Use when the contributor's project uses Appwrite — or wants to start using it — for authentication (sign-in, magic links, OAuth), cloud databases (CRUD with realtime sync), file storage, or presence (who's online). Triggers on "let users sign in", "add login/signup", "save this to the cloud", "let users upload files", "show who's online", "make this multiplayer/multi-user". First check whether manifest.json has an `appwrite` block — if not, treat this as first-time setup and walk through it. If yes, proceed to the operation. SKIP for projects without Appwrite if the contributor hasn't asked to add it.
---

# Working with Appwrite in Manifest

Appwrite is Manifest's recommended backend for anything that needs persistence, auth, or real users. Open-source, generous free cloud tier, configured via `manifest.json`. All four Appwrite plugins (auth, database, storage, presence) share the same setup and access patterns.

## Step 0 — detect setup state

**Always do this first.** Open `manifest.json` and look for an `appwrite` block.

- **No `appwrite` block** → this is **first-time setup**. The contributor needs to do the Appwrite console steps themselves; you can't do them via the CLI. Walk them through "Setup" below.
- **Has `appwrite` block** → Appwrite is configured. Skip setup and go to the relevant operation (Auth, Database, Storage, or Presence).

Also check `index.html` for the Appwrite SDK script tag — it must come **before** `manifest.js`:
```html
<script src="https://cdn.jsdelivr.net/npm/appwrite@latest"></script>
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"></script>
```

## Setup (first time)

The contributor must do the Appwrite-side parts in the Appwrite console themselves — Claude cannot create projects, tables, or configure auth providers via CLI.

1. **Tell the contributor what they need to do in Appwrite:**
   - Sign up at https://appwrite.io (free) or self-host.
   - Create a project; pick any name and region.
   - Copy the **Project ID** and **API Endpoint** from Settings → API credentials.
   - (Optional, dev only) Create a **Dev Key** under Overview → Dev keys to bypass rate limits.

2. **Wait for them to share Project ID + Endpoint** (and optionally Dev Key). Don't proceed with placeholders — broken setup is worse than no setup.

3. **Add the Appwrite SDK script** to `index.html` before the `manifest.min.js` script (see above).

4. **Add the credentials to `manifest.json`** under an `appwrite` block. **Project ID and endpoint are public** (per Appwrite's own docs — safe to commit). The **dev key is sensitive** (bypasses rate limits) and should NEVER be committed. Use `${VAR}` interpolation for it:
   ```json
   {
     "appwrite": {
       "projectId": "<from console>",
       "endpoint": "<from console>",
       "devKey": "${APPWRITE_DEV_KEY}"
     }
   }
   ```

5. **Set the env var** in a standard `.env` file at the project root:
   ```
   APPWRITE_DEV_KEY=<paste from console>
   ```
   Both `mnfst-run` (dev server) and `mnfst-render` (prerender) read `.env` automatically. For runtime browser usage, the dev server serves a generated `/env.js` from this file — make sure `index.html` has `<script src="/env.js"></script>` before the `manifest.min.js` script tag (the starter template includes this by default).

   For **multiple Appwrite projects** in one Manifest project, name the variables per-project: `${APPWRITE_DEV_KEY_MARKETING}`, `${APPWRITE_DEV_KEY_DASHBOARD}`, etc., and reference each in the matching data-source's credentials block.

6. **Confirm `.env` is in `.gitignore`** before the contributor commits anything. (Most starter templates include it; verify.)

7. **Verify in the preview panel.** Open the browser console and check for Appwrite connection errors.

## Auth

When the contributor wants sign-in/signup. Manifest's auth plugin handles unrecognized-user account creation automatically — no separate signup flow needed.

1. **In `manifest.json`**, add an `auth.methods` array to the `appwrite` block:
   ```json
   {
     "appwrite": {
       "projectId": "...",
       "endpoint": "...",
       "auth": {
         "methods": ["oauth", "magic", "guest-manual"]
       }
     }
   }
   ```

   Method options:
   | Method | What it does |
   |---|---|
   | `oauth` | Sign in with Google, GitHub, Discord, Apple, +35 others |
   | `magic` | Email a passwordless sign-in link (1 hour, single-use) |
   | `guest-auto` | Auto-create anonymous session on every visit |
   | `guest-manual` | Let the user opt into a guest session via `$auth.createGuest()` |

2. **Tell the contributor what to do in Appwrite:** Auth → Settings → enable the matching providers (e.g. enable Google OAuth, configure redirect URIs). Methods declared in `manifest.json` must also be enabled in Appwrite, otherwise sign-in fails silently.

3. **Use `$auth` in HTML.** Common patterns:
   ```html
   <!-- OAuth -->
   <button @click="$auth.loginOAuth('google')" :disabled="$auth.inProgress">
     Sign in with Google
   </button>

   <!-- Magic link -->
   <input type="email" x-model="email">
   <button @click="$auth.sendMagicLink(email)" :disabled="$auth.inProgress">
     Email me a sign-in link
   </button>
   <p x-show="$auth.magicLinkSent">Check your inbox.</p>

   <!-- Logout -->
   <button @click="$auth.logout()" x-show="$auth.isAuthenticated">Sign out</button>

   <!-- Conditional UI -->
   <div x-show="$auth.isAuthenticated">Hi, <span x-text="$auth.user?.email"></span></div>
   <div x-show="!$auth.isAuthenticated">Please sign in.</div>
   <div x-show="$auth.error" x-text="$auth.error" class="negative"></div>
   ```

   Common `$auth` properties: `isAuthenticated`, `isAnonymous`, `user`, `inProgress`, `error`, `magicLinkSent`, `magicLinkExpired`, `teams`, `currentTeam`, `method`, `provider`.

4. **Teams (optional, for multi-tenant apps)** are documented in the Appwrite teams docs. Use `$auth.teams`, `$auth.currentTeam`, `$auth.viewTeam(team)`. Combine with database `scope: "team"` for team-scoped data.

## Database (cloud data)

When the contributor wants persistent, multi-user data (leaderboards, comments, posts, settings).

1. **Tell the contributor what to do in Appwrite:**
   - In Databases → create a database (any name).
   - Create a table inside it.
   - Add columns matching the data shape they want (Appwrite auto-adds `$id`, `$createdAt`, `$updatedAt`).
   - In the table's Settings → Permissions, enable the operations the frontend needs (Create, Read, Update, Delete) for the right roles (e.g. `users` for any signed-in user, `any` for public).
   - Copy the **Database ID** and **Table ID**.

2. **Register the table in `manifest.json`** under `data` (same place as local sources):
   ```json
   {
     "data": {
       "projects": {
         "appwriteDatabaseId": "<database-id>",
         "appwriteTableId": "<table-id>",
         "scope": "user"
       }
     }
   }
   ```

   `scope` auto-filters queries so users only see their own data:
   - `"user"` — current user's rows only (filters by `userId` column)
   - `"team"` — current team's rows (filters by `teamId`)
   - `"teams"` — all teams the user belongs to
   - `["user", "team"]` — either the user's or current team's
   - Omit for public data

3. **CRUD operations in HTML.** Same `$x.sourceName` as local data, plus:
   ```html
   <!-- Create -->
   <button @click="$x.projects.$create({ name: 'New', type: 'demo' })">Add</button>

   <!-- Read (auto-loaded) -->
   <template x-for="project in $x.projects" :key="project.$id">
     <p x-text="project.name"></p>
   </template>

   <!-- Update -->
   <input :value="project.name" @blur="$x.projects.$update(project.$id, { name: $event.target.value })">

   <!-- Delete -->
   <button @click="$x.projects.$delete(project.$id)">Remove</button>

   <!-- Duplicate (Appwrite-specific) -->
   <button @click="$x.projects.$duplicate(project.$id, { files: 'same' })">Duplicate</button>
   ```

   Realtime sync is automatic — changes from one tab/user appear in others without a reload.

## Storage (file uploads)

When the contributor wants users to upload files (avatars, attachments, images).

1. **Tell the contributor what to do in Appwrite:** Storage → create a bucket → set permissions (Create/Read for the right roles). Copy the Bucket ID.

2. **Register the bucket in `manifest.json`** under `data`:
   ```json
   {
     "data": {
       "uploads": {
         "appwriteBucketId": "<bucket-id>"
       }
     }
   }
   ```

3. **Upload via `$x.uploads.$create(file)` from a file input.** See the Appwrite storage plugin docs for full upload/download/preview methods. (This skill stays brief; cite docs for specifics.)

## Presence

When the contributor wants real-time "who's online" or activity tracking. Less common; cite the presence plugin docs.

## What not to do

- **Don't try to do Appwrite console steps via CLI.** Project, table, bucket creation and permissions are GUI actions. Tell the contributor what to do; don't pretend you've done it.
- **Don't commit a `devKey` to git, ever.** Use `${APPWRITE_DEV_KEY}` interpolation backed by a gitignored `.env` file at the project root. Dev keys bypass rate limits and shouldn't ship.
- **Don't skip permissions in the Appwrite console.** A registered table with no `Create` permission will silently fail on `$create()`.
- **Don't put auth methods in `manifest.json` that aren't enabled in Appwrite** (and vice versa) — they must match.
- **Don't store secrets, API keys, or third-party tokens in Appwrite documents** unless the table is properly scoped — Appwrite's permission model is the security boundary.
- **Don't proceed with placeholder credentials** (`"<your-project-id>"`). The contributor must paste real values from the Appwrite console first.

## Further reading

If the recipe above doesn't cover the situation, consult:
- Appwrite Setup (credentials, dev key, plugin loading): https://manifestjs.org/docs/appwrite-plugins/appwrite-setup
- Users (sign-in methods, OAuth, magic links, guest sessions): https://manifestjs.org/docs/appwrite-plugins/users
- Teams (multi-tenant scoping, team management): https://manifestjs.org/docs/appwrite-plugins/teams
- Databases (CRUD methods, scope, queries, realtime): https://manifestjs.org/docs/appwrite-plugins/databases
- Storage (file upload/download/preview): https://manifestjs.org/docs/appwrite-plugins/storage
