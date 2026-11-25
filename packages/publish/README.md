# mnfst-publish

One command to put a Manifest project online (managed hosting):

```bash
npx mnfst-publish              # build + publish to production, print the live URL
npx mnfst-publish --staging    # publish to a staging preview URL
npx mnfst-publish --promote    # promote the current staging build to production
```

It reads your project's API key from `.env` (`MANIFEST_API_KEY`) and the MCP
endpoint from `.mcp.json`, renders the site if it's a prerendered ("website")
project, zips it gitignore-aware, uploads it, and prints the live URL.

Flags: `--staging` / `--production` (default), `--no-render`, `--promote`,
`--list`, `--source render|spa` (auto-detected), `--key <key>`, `--mcp <url>`,
`--version`, `--help`. An unknown option is refused with exit code 1 and
nothing is published.

## Release scripts

Review a build at its own address before it reaches production, then ship
exactly that build:

```bash
npx mnfst-publish --list --json
# {"ok":true,"env":"production","live_deployment_id":"dep_…","deployments":[{"deployment_id":"dep_…","status":"ready","is_live":true,"held":false,"label":null,"preview_url":null,"published_at":"…","source":"render"},…]}
npx mnfst-publish --no-live --label "v2.4.0" --json
# {"ok":true,"env":"staging","deployment_id":"dep_…","live":false,"preview_url":"https://preview--….manifestx.ai",…}
npx mnfst-publish --promote --deployment dep_… --expect-live dep_… --json
```

- `--no-live`: staging only. Stores the deployment without changing what
  staging serves and prints its preview URL (unlisted, noindex).
- `--label <text>`: names the deployment (up to 200 characters).
- `--promote --deployment <id>`: promotes exactly that staging deployment;
  staging is unchanged. Without `--deployment`, promotes what staging serves.
- `--expect-live <id>`: with `--promote`, refuses unless production is serving
  that deployment, checked in the same step as the switch.
- `--list`: recent deployments and which one is live (production, or staging
  with `--staging`). Publishes nothing.
- `--json`: the result as one JSON object on stdout; progress goes to stderr.
  A failure is `{"ok":false,"error":"<code>","message":"…"}` with exit code 1.
  Promote refusals use the server's codes: `unknown_deployment`, `not_staging`,
  `not_ready`, `live_moved`, `nothing_on_staging`, `promote_in_progress`,
  `promote_failed`. The CLI adds `usage` (bad options), `no_api_key`,
  `unsupported_server` (the server lacks a flag you passed; nothing changed)
  and `promoted_other`. A server older than these codes reports `refused`.

Against a server that doesn't support these yet, mnfst-publish stops before
uploading or promoting anything.

Publishing from Claude with the Manifest connector needs no key: the command it
gives you carries a one-time upload link. While the site renders, mnfst-publish
keeps that link alive (up to 3 hours). If a link still expires, ask Claude to
publish again and add `--no-render` to the new command, so the site already
rendered on disk uploads without rendering again.

Zero dependencies, cross-platform (pure-Node zip). `.env`, `.env.*`, `.claude/`,
keys and credential files are never uploaded.
