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
`--source render|spa` (auto-detected), `--key <key>`, `--mcp <url>`.

Zero dependencies, cross-platform (pure-Node zip). `.env`, `.env.*`, and
`.claude/` are never uploaded.
