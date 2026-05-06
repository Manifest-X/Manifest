---
name: manifest-data
description: Use when the contributor wants to load, display, or edit content stored as data in a Manifest project — CSV, JSON, YAML, or an API endpoint. Triggers on "load data from this file", "show a list of products/team members/etc", "pull from this API", "use this spreadsheet", and on edits to existing data like "add Sarah to the team", "update the pricing", "change the FAQ". Data sources are registered in manifest.json and accessed via $x.sourceName in templates. For Appwrite-backed data (full CRUD, real-time, auth-scoped), prefer the manifest-appwrite skill if available. SKIP for hardcoded one-off content that isn't really data.
---

# Working with data sources in Manifest

Data sources are external content (CSV, JSON, YAML, API) registered in `manifest.json` and accessed in HTML templates via the `$x` magic property. The Manifest data plugin handles fetching, parsing, and reactive updates.

This skill covers two related tasks: **connecting a new data source** and **editing data in an existing source**.

## Editing data in an existing source

This is the more common task. When the user says "add Sarah to the team", "fix the pricing", "update the FAQ":

1. **Find the source.** Open `manifest.json` and look at the `data` block to find which file backs the user's request. Then open that file directly.
2. **Match the existing format** (CSV columns, JSON shape, YAML structure). Keep the existing style — quoting, indentation, key order.
3. **Edit the file.** For CSVs, preserve the column order; for JSON/YAML, place new entries near similar ones unless the user specified order.
4. **No HTML changes are needed** — the page automatically reflects the new data on reload, because templates iterate the source via `$x.<source>`.
5. **Verify in the preview panel.** Confirm the new/edited entry appears.

## Connecting a new data source

When the user wants to add a *new* source (not edit existing):

1. **Decide the source format.** Match what the user has:
   - **CSV** — best for tabular data the user might edit in a spreadsheet (products, team, FAQ items). Two modes:
     - **Tabular**: first column header is `id` (case-insensitive). Each row is an object. Other columns become properties.
     - **Key/value**: first column = key, second column = value. Dot notation in keys creates nesting (`features.0.name` becomes `features[0].name`). Use this for translatable copy or settings.
   - **JSON** — best for nested/structured data the user won't hand-edit.
   - **YAML** — same use cases as JSON, more human-friendly to edit.
   - **API endpoint** — external URL returning JSON. **Read-only** today (see "What not to do" below).

2. **Place the file** in a sensible location:
   - Static files: `/data/<name>.<ext>` (create the folder if it doesn't exist) or root if it's project-level (e.g. `locales.csv`).
   - API: no file — just the URL.

3. **Register in `manifest.json`** under the `data` key:
   ```json
   "data": {
     "products": "/data/products.csv",
     "team": "/data/team.json",
     "weather": {
       "url": "${API_BASE_URL}/weather",
       "headers": { "Authorization": "Bearer ${API_TOKEN}" },
       "transform": "data.current",
       "defaultValue": {}
     }
   }
   ```
   - Nested namespaces are allowed: `"content": { "locales": "/locales.csv" }` → access as `$x.content.locales`.
   - For APIs, `${VAR}` interpolates from `process.env` (build-time) or `window.env` (runtime). Always provide a `defaultValue` so the UI doesn't break on fetch failure.

4. **Use it in HTML.** All standard JS array methods work on data arrays.
   ```html
   <!-- Single value -->
   <h1 x-text="$x.content.welcomeMessage"></h1>

   <!-- List -->
   <ul>
     <template x-for="product in $x.products" :key="product.id">
       <li x-text="product.name"></li>
     </template>
   </ul>

   <!-- Loading / error / ready states -->
   <div x-show="$x.products.$loading">Loading…</div>
   <div x-show="$x.products.$error" x-text="$x.products.$error"></div>

   <!-- Find item matching current URL segment -->
   <article x-show="$x.posts.$route('slug')">
     <h1 x-text="$x.posts.$route('slug').title"></h1>
   </article>

   <!-- Search -->
   <template x-for="hit in $x.products.$search(query, 'name', 'description')" :key="hit.id">
     <li x-text="hit.name"></li>
   </template>

   <!-- Filter / sort / paginate -->
   <template x-for="row in $x.products.$query([
     ['equal', 'inStock', true],
     ['orderAsc', 'price'],
     ['limit', 10]
   ])" :key="row.id">
     <li x-text="row.name"></li>
   </template>
   ```

   `$query` operators: `equal`, `notEqual`, `greaterThan`, `lessThan`, `between`, `isNull`, `isNotNull`, `contains`, `startsWith`, `endsWith`, `orderAsc`, `orderDesc`, `orderRandom`, `limit`, `offset`. Combine multiple in the array.

5. **Markdown content** doesn't go in `data`. Use `<section x-markdown="'/path/to/file.md'"></section>` (note the apostrophes) to render a markdown file. Or store the path in a data source field and render with `x-markdown="$x.posts.$route('slug').body"`.

6. **Verify in the preview panel.** Confirm the data renders. Open the browser console and look for fetch errors (404, CORS) — surface them in plain terms if present.

## What not to do

- **Don't import data via `<script>`** or fetch it manually with `fetch()` — register it in `manifest.json` instead. The data plugin handles caching and reactivity.
- **Don't put secrets in registered data sources** — they are fetched from the browser, so anything there is public. For private data, use Appwrite (see the `manifest-appwrite` skill if available) or a server-side proxy.
- **Don't try to write back to API data sources.** The core data plugin is **read-only** for APIs today: only GET requests are fully supported (POST/PUT/DELETE accept the method but request bodies aren't sent). For full CRUD, real-time updates, and auth-scoped data, switch to Appwrite databases.
- **Don't forget the `data` key in `manifest.json`** — the source will silently fail to load.
- **Don't add a CSV/JSON file just for "settings" or "config"** if you can put the value in `manifest.json` directly (already accessible as `$x.manifest.fieldName`).

## Further reading

If the recipe above doesn't cover the situation, consult:
- Local Data (covers file sources, API sources, environment variables, `$query` operators, `$route`, array methods): https://manifestjs.org/docs/core-plugins/local-data
- Markdown (rendering markdown files referenced from data fields): https://manifestjs.org/docs/core-plugins/markdown
