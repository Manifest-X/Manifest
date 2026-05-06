# Project

<!-- Fill in for your project or remove -->

- **Name:** (your project name)
- **What it is:** (one sentence — e.g. "marketing site for Acme", "internal tool for the design team", "tower-defense game")
- **Staging URL:** (none)
- **Production URL:** (none)
- **Default branch:** `staging`
- **Live branch:** `production`

> The contributor working in this repo may be non-technical. Speak plainly. When you make a change, describe what they will *see* (in the preview), not what you *did* in code.

## Framework

This project is built on the [Manifest framework](https://manifestjs.org). Manifest is an Alpine.js-based framework that runs directly in the browser — no build step. Edit HTML, CSS, and data files.

You don't need to read this whole framework section to make small edits. Skip ahead if the user just asked for a copy change or color tweak.

### Project type

- **SPA**: served from the repo root. No render step. The browser is the runtime.
- **Website**: source files live at the repo root; pre-rendered HTML is generated into `/website/` for SEO and faster first paint. **Edit the source, never `/website/` directly.** The render regenerates `/website/` from source.

To tell which: look for a `prerender` block in `manifest.json` or a `/website/` folder. If neither, treat as SPA.

### Where things live in the starter template

- `index.html` — the page. Routes are populated by elements with an `x-route` attribute.
- `components/*.html` — reusable HTML chunks. Used as `<x-filename>` (e.g. `header.html` → `<x-header>`).
- `manifest.json` — registers components, data sources, and project metadata. **Update this when adding components or data sources.**
- `manifest.theme.css` — colors, fonts, spacing, radii. CSS custom properties. **Edit values here, never hardcode colors elsewhere.**
- `locales.csv` — translations (if the project is multi-language).

### Key conventions

**Routing.** Routes are visibility-based, not navigation-based. A `<section x-route="pricing">` shows when the URL matches `/pricing`. Patterns:

- `x-route="/"` — root only
- `x-route="about"` — `/about` and any subroutes
- `x-route="=about"` — exact `/about` only
- `x-route="about/*"` — subroutes only
- `x-route="!admin"` — everywhere except `/admin`
- `x-route="!*"` — fallback (404)

**Components.** A file at `components/card.html` becomes `<x-card>` anywhere on the page. Register it in `manifest.json`:
- `preloadedComponents` — loaded on initial page load (use for header/footer/anything visible immediately)
- `components` — lazy-loaded on demand (use for everything else)

To expose customization points to instances, use `$modify('attrName')` inside the component HTML — attributes on `<x-card heading="Hello">` then flow through.

**Data.** Data sources are registered under `"data"` in `manifest.json`:
```json
"data": {
  "products": "/data/products.csv",
  "team": "/data/team.json"
}
```
Then accessed in templates via `$x.products`, `$x.team`, etc. CSV with first column header `id` (case-insensitive) is tabular; otherwise it's key/value with dot-notation nesting.

**Theme.** Use the semantic CSS variables in `manifest.theme.css`:
- Surfaces: `--color-page`, `--color-surface-1/2/3`
- Text: `--color-content-stark`, `--color-content-neutral`, `--color-content-subtle`
- Brand: `--color-brand-surface`, `--color-brand-content`, etc.
- Sizing: `--radius`, `--spacing`, `--spacing-content-width`

When a non-technical user says "make it more rounded" or "use a warmer brand color", change the variable, not individual elements.

**Styling — the layer cascade.** When styling a specific element, reach for tools in this order:
1. **Pre-styled HTML.** Manifest auto-styles raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<form>`, `<dialog popover>`, `<details>`/`<summary>`, `<table>`, `<aside popover>`, `<menu popover>`. Don't wrap them in custom classes for basic styling.
2. **Manifest semantic classes.** Layout: `page`, `content`, `row`, `row-wrap`, `col`, `col-wrap`, `center`. Color modifiers (on buttons, inputs, text): `brand`, `accent`, `negative`, `positive`. Appearance: `ghost`, `outlined`, `hug`, `selected`, `transparent`. Sizes: `sm`, `lg`. Typography: `h1`–`h6`, `paragraph`, `small`, `caption`, `prose` (use on long-form text containers like article bodies). Misc: `unstyle` (opt out of Manifest styling on an element), `overlay-dark`/`overlay-light` (banner overlays), `trailing` (push icon to right edge), `no-focus`, `no-scrollbar`.
3. **Theme-derived utilities.** Manifest auto-generates Tailwind-compatible utilities from the theme variables: `bg-brand-surface`, `text-content-stark`, `border-line`, etc. Use these for one-off styling that should still respect the theme.
4. **Tailwind utilities.** Tailwind is opt-in via `data-tailwind` on the `<script>` tag (default ON in the starter). Use Tailwind for layout/spacing utilities the semantic classes don't cover.

**Never use inline `style="..."` or hardcoded color/font/size values.** If the right variable doesn't exist, add one to `manifest.theme.css`.

**Directives & magic methods quick reference.** Recognise these in HTML; they're Manifest- or Alpine-specific:
- `x-route="path"` — show/hide based on URL
- `x-icon="lucide:name"` — Iconify icon (200k+ icons; common sets: `lucide`, `mdi`, `simple-icons`)
- `x-markdown="'inline string'"` / `x-markdown="'/path.md'"` / `x-markdown="$x.source.field"` — render markdown
- `x-tooltip="text"` — hover tooltip (modifiers: `.top`, `.bottom`, `.start`, `.end`)
- `x-dropdown="menu-id"` — open `<menu popover id="menu-id">`
- `x-toast="message"` — push notification (modifiers: `.brand`, `.accent`, `.positive`, `.negative`)
- `x-tab="id"` / `x-tabpanel="id"` — tab control + content
- `x-resize` — drag-to-resize edges/corners
- `x-colorpicker.swatch` — dropdown color picker UI
- `$x.sourceName` — registered data source
- `$url.paramName.value/.set()/.add()/.remove()` — URL query params (filters, search)
- `$x.source.$route('field')` — find data item matching current URL segment
- `$auth` — Appwrite auth (only if Appwrite is configured)

For client-side state persistence (e.g. game saves, draft form state), Alpine has `$persist`. For cloud persistence, use Appwrite (see the `manifest-appwrite` skill if installed).

## Workflow — the slash commands

These are buttons. Press one and it runs end-to-end.

1. **`/preview`** — start the local preview server. Use if the preview panel isn't already running.
2. **`/sync`** — pull the latest from the team. Run at the start of a work session.
3. **`/staging`** — save your work and publish to the staging site. Auto-renders if it's a website project.
4. **`/publish`** — promote staging to live. Run only after eyeballing staging.
5. **`/status`** — plain-English summary of where things stand.

The slash commands assume the host (Appwrite Sites, Netlify, Cloudflare Pages, etc.) is already wired to the repo. For first-time host setup, custom domains, production env vars, or PWA install behaviour — see the **manifest-deploy** skill.

## Rules for Claude

- **Never commit directly to the live branch.** Promote from staging via `/publish`.
- **Never force-push, never `--no-verify`, never skip git hooks.**
- **Never commit anything that looks like a secret** (`.env`, `*.key`, `*.pem`, `credentials*`). Stop and warn the user if one is staged.
- **Edit source files, not generated output in `/website/`.**
- **Use theme variables, not hardcoded colors or fonts.** If the right variable doesn't exist, add one to `manifest.theme.css` rather than inlining.
- **Update `manifest.json` when you add a component or data source** — otherwise it won't load.
- **Use semantic HTML.** `<button>` for buttons (not `<div onclick>`); label-input nesting for forms (`<label>Name<input></label>`); `alt` attribute on every `<img>`; one `<h1>` per page. Manifest's pre-styling and accessibility behaviour assume semantic markup.
- **Keep markup minimal — no Tailwind-template wrapper soup.** Manifest's CSS targets semantic HTML directly. If a `<div>` exists only to apply one class to its child, hoist the class up and delete the wrapper. If you find yourself nesting three divs to position one element, you're fighting the framework — reach for a Manifest semantic class (`row`, `col`, `center`, `content`) instead.
- **Design mobile and desktop with shared markup.** Don't write two separate layouts swapped at a breakpoint. Use layouts that flex naturally (`row-wrap`, `col`, `grow`, `gap-N`) and reach for `md:`/`lg:` Tailwind prefixes only when the layout genuinely needs to change shape — not as a default.
- **For anything unusual** (detached HEAD, merge in progress, unexpected remote state, missing branches): stop, explain in plain terms, ask before recovering. Do not improvise destructive fixes.
- **After making a visible change, verify in the preview panel** before reporting done. Describe what changed in user-visible terms ("the hero headline is now larger and centered"), not as a diff.
