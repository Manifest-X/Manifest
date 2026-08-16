# Manifest Development

## Quick Start

```bash
npm run start:src      # Serve /src (framework test project)
npm run start:starter  # Serve /templates/starter (starter template)
npm run start:dist     # Serve /src/test-prerender (prerendered MPA output; run `npm run render` first)
```

All servers use `mnfst-run` (`packages/run/serve.mjs`) with zero npm dependencies. SPA vs MPA mode is auto-detected from the served `index.html`.

---

## Build

```bash
npm run build
```

**Build output:**
- Combines subscripts into monolith plugin files (`manifest.components.js`, `manifest.router.js`, `manifest.data.js`, etc.)
- Bundles and minifies CSS from `/src/styles` into `manifest.css` / `manifest.min.css`
- Syncs starter template from `/templates/starter` to `/packages/create-starter/templates`
- Copies all files to `/lib` for npm publishing

Only the dynamic loader (`manifest.js`) is produced — it loads plugins on-demand from CDN.

---

## Prerender

```bash
npm run render              # Prerender /src → /src/test-prerender (untracked output)
npm run prerender:starter   # Prerender /templates/starter
```

---

## NPX Commands

These are the CLI commands available to framework users in the wild:

| Command | Package | Description |
|---------|---------|-------------|
| `npx mnfst-starter MyProject` | `mnfst-starter` | Scaffold a new project from the starter template |
| `npx mnfst-render` | `mnfst-render` | Prerender a Manifest SPA into a static MPA output folder |
| `npx mnfst-run` | `mnfst-run` | Serve a project locally — SPA or MPA auto-detected. Opens browser automatically. |

---

## Publish to npm

Each package is published independently. Build first when publishing the main `mnfst` package.

### Main package (mnfst)

```bash
npm run build
npm version patch        # or minor / major
git add .
git commit -m "Release vX.X.X"
git tag vX.X.X
git push origin master
git push origin vX.X.X
npm publish --access public
```

### Sub-packages

```bash
npm run publish:starter  # publishes packages/create-starter → mnfst-starter
npm run publish:render   # publishes packages/render        → mnfst-render
npm run publish:run      # publishes packages/run           → mnfst-run
```

**Note:** You must be logged into npm (`npm login`) before publishing.

> **First-run prompt:** `npx` asks for install confirmation the first time a new package version is downloaded. This is an npm security feature and cannot be suppressed from within the package — it only appears once per version, after which the package is cached locally.

### CDN (jsDelivr)

After publishing `mnfst`, files are available at:

```
https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.js
https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.css
https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.css
https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.components.js
https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.data.js
```

---

## Version Numbering

All packages use independent semantic versioning (MAJOR.MINOR.PATCH).

| Package | Location | Notes |
|---------|----------|-------|
| `mnfst` | `package.json` | Main framework — build before publishing |
| `mnfst-starter` | `packages/create-starter/package.json` | Starter template scaffolder |
| `mnfst-render` | `packages/render/package.json` | Prerender CLI |
| `mnfst-run` | `packages/run/package.json` | Dev server CLI |

```bash
git tag --list | tail -5   # Check existing tags before bumping
```
