# mnfst-test

Testing toolkit for Manifest projects:

- **CLI project linter**: `npx mnfst-test` catches typo'd component tags, dead data sources, syntax errors in Alpine expressions, runtime console errors, accessibility violations, and broken internal links. Run from CI, pre-commit, or autonomously by AI agents.
- **Fake data backend**: `createFakeAppwrite()` is an in-memory Appwrite backend shaped like the Web SDK. Manifest's real data plugins run on top of it, so `$x`, `$query`, paging, writes and realtime behave as they do in production. One shared fake instead of one per test file.
- **Golden journeys**: `mnfst-test journeys` drives the app in headless Chrome on the fake (or against staging), with screenshot baselines and pixel diffs.
- **Component test helper**: `mountManifest()` boots a snippet of HTML (or a full page) with Alpine and Manifest plugins active, returns query and interaction helpers. For Vitest + happy-dom.

## Install

```bash
npm install -D mnfst-test
```

That's it for the linter. Component-level tests and runtime checks have optional peer deps:

```bash
# For mountManifest() and Vitest tests
npm install -D mnfst-test happy-dom vitest

# For runtime checks (console errors, a11y, dead links via headless Chrome)
npm install -D mnfst-test puppeteer
```

If you want Alpine to be loaded from a local install instead of the jsDelivr CDN at test time:

```bash
npm install -D alpinejs
```

---

## CLI: `mnfst-test`

From the root of a Manifest project (next to `manifest.json`):

```bash
npx mnfst-test
```

Exits 0 if there are no errors (warnings allowed), 1 if errors are found, 2 on setup failure (missing manifest, parse error).

### Options

```
--root <path>       Project root (default: .)
--manifest <path>   manifest.json relative to root (default: manifest.json)
--only <kind>       Run only "static" or "runtime" checks
--ignore <dir>      Skip a directory (repeatable). Common: prerender output
--external          Also fetch external <a href> links and report non-200s
--json              Emit machine-readable JSON instead of formatted output
--quiet, -q         Suppress passing checks; show only warnings/errors
-h, --help          Show usage
```

### What it checks

**Static (no headless browser)**

- **Manifest integrity** — every component file path and data-source file path resolves on disk; no duplicate component entries; missing `$schema` warned.
- **PWA completeness** — required and recommended fields for installable PWAs.
- **Component references** — every `<x-foo>` tag matches a registered component; every registered component is used somewhere; no two files claim the same tag.
- **Data source references** — every `$x.<name>` matches a registered source; unused sources flagged.
- **Directive expression syntax** — every `x-data`, `x-show`, `x-text`, `x-if`, `x-for`, `x-bind:*`, `@*`, `:*`, `x-effect` is parseable as JavaScript.
- **Route consistency** — internal `<a href>` values resolve to a registered `x-route` pattern or a static file.
- **Locale parity** — localized data sources have the same set of keys across all locales.

**Runtime (requires puppeteer)**

- **Console errors** — boots the project headlessly and reports anything logged to `console.error` or thrown as a page error.
- **Accessibility** — runs axe-core against the booted page; serious/critical violations report as errors, others as warnings.
- **External links** — with `--external`, fetches each `http(s)://` link and reports non-200 responses.

### Installing puppeteer (optional)

Runtime checks are skipped with clear instructions if puppeteer isn't available:

```bash
npm install -D puppeteer
```

If puppeteer launches but cannot find a Chromium binary:

```bash
npx puppeteer browsers install chrome
```

### JSON output

For CI and AI-agent consumption:

```bash
npx mnfst-test --json
```

```json
{
    "status": "error",
    "summary": { "errors": 2, "warnings": 1, "checks": 8 },
    "checks": [
        {
            "name": "components",
            "label": "Component references",
            "status": "error",
            "details": "5 components, 4 used",
            "issues": [
                {
                    "severity": "error",
                    "message": "<x-headerr> used but no component named \"headerr\" is registered",
                    "file": "components/main.html",
                    "line": 12
                }
            ]
        }
    ],
    "skipped": []
}
```

### Common patterns

**CI**:

```yaml
- run: npx mnfst-test --json > check.json || true
- run: cat check.json
```

**Pre-commit**:

```bash
npx mnfst-test --only static --quiet
```

Static checks are fast and don't require a Chromium download — ideal for hooks.

**AI agents**:

Run with `--json` after generating or editing project files. A non-zero exit means the AI's output has issues to address before reporting completion.

---

## Library: `mountManifest()`

For testing component-level logic — `x-data` factories, prop merging, computed values — with [Vitest](https://vitest.dev) and [happy-dom](https://github.com/capricorn86/happy-dom).

```js
// cart.test.js
import { describe, it, expect } from 'vitest';
import { mountManifest } from 'mnfst-test';

describe('cart', () => {
    it('adds a product and updates the total', async () => {
        const { $, click } = await mountManifest({
            html: `
                <div x-data="{ items: [], total: 0, add(p) { this.items.push(p); this.total += p.price; } }">
                    <button @click="add({ id: 'sku-1', price: 10 })">Add</button>
                    <span data-testid="total" x-text="total"></span>
                </div>
            `
        });

        click('button');
        expect($('[data-testid=total]').textContent).toBe('10');
    });
});
```

### `mountManifest(opts)`

| Option     | Type        | Description |
|------------|-------------|-------------|
| `html`     | `string`    | HTML body to mount. Required unless `page` is set. |
| `page`     | `string`    | Path to a full HTML file to load as the document. |
| `manifest` | `object`    | In-memory `manifest.json`. Defaults to `{}`. |
| `data`     | `object`    | In-memory data sources, keyed by name. Each becomes `$x.<key>`. |
| `plugins`  | `string[]`  | Paths to Manifest plugin files (e.g. `lib/manifest.data.js`) to evaluate after Alpine loads. |
| `appwrite` | `object`   | A `createFakeAppwrite()` instance or its options, installed as `window.Appwrite` before plugins. Returned as `fake`. |
| `settle`   | `number`    | Milliseconds to wait after mount for Alpine to render. Default `50`. |

Returns:

| Member        | Description |
|---------------|-------------|
| `window`      | The happy-dom Window |
| `document`    | Shortcut to `window.document` |
| `body`        | Shortcut to `document.body` |
| `$(sel)`      | First match of a CSS selector |
| `$$(sel)`     | All matches of a CSS selector |
| `getByText(t)`| First element whose textContent equals `t` |
| `getByRole(r)`| First element with `role="r"` |
| `getById(id)` | `getElementById` |
| `click(t)`    | Dispatch a click on a selector or element |
| `type(t, v)`  | Set value and dispatch input/change events |
| `tick(ms?)`   | Wait for Alpine to flush pending updates |
| `unmount()`   | Tear down the window |

### Limitations

- happy-dom is not a real browser. Layout, scrolling, and most CSS-driven behavior is approximated. For visual or layout testing, use golden journeys.
- Manifest plugins that use Web Components (e.g. `<x-code>`) work in happy-dom but with caveats around `customElements.define` timing — explicitly load the relevant plugin via `opts.plugins` if you need its behavior.
- The router plugin is rarely needed for component-level tests. Validate routing with `mnfst-test` (static) or Playwright (runtime).

---

## Fake data backend: `mnfst-test/fake`

```js
import { createFakeAppwrite } from 'mnfst-test/fake';

const fake = createFakeAppwrite({
    databases: { main: { tasks: [{ $id: 't1', title: 'Write docs', done: false }] } }
});
```

The fake mirrors Appwrite, not an idealised database:

- Queries are the SDK's JSON strings: `equal`, `notEqual`, comparisons, `between`, `isNull`/`isNotNull`, `startsWith`/`endsWith`, `contains`, `search` (prefix words, any term), `or`/`and`, the date helpers, `orderAsc`/`orderDesc`/`orderRandom`, `select`, `limit`, `offset`, `cursorAfter`/`cursorBefore`. Unknown methods are 400s.
- String matching and sorting are case-insensitive (the default collation). Nulls sort first ascending.
- No `limit` returns 25 rows; `limit` above 5000 is a 400; `total` is capped at 5000. When a request carries two `limit`s (or offsets, or cursors) the first wins, as on Appwrite.
- Writes stamp `$id`, `$sequence`, `$createdAt`, `$updatedAt` from a fixed clock, and duplicate ids are 409s.
- Every write emits a realtime message with Appwrite's event names and channels; subscriptions with queries are filtered server-side the way Appwrite filters them.

| Member | Description |
|---|---|
| `sdk` | `window.Appwrite`-shaped: `Client`, `TablesDB`, `Storage`, `Realtime`, `Account`, `Teams`, `Query`, `ID`, `Role`, `Permission`, `AppwriteException` |
| `install(window)` | Sets `window.Appwrite` to the fake SDK |
| `tablesDB` | A ready `TablesDB`, for testing stores that take one directly |
| `table(db?, id)` | Backend handle: `rows()`, `get(id)`, `count()`, `insert(data)`, `update(id, data)`, `remove(id)`, `seed(rows)`, `clear()`. Writes here are "another user": they emit realtime |
| `calls` / `lastQueries(table?)` | Every SDK call, and the parsed queries of the latest list |
| `failNext(method, error?)` | Fail the next call (`'listRows'`, `'createRow'`, `'*'`…) |
| `signIn(user, teams?)` / `signOut()` | What `Account.get()` and `Teams.list()` return |

Options: `databases`, `buckets`, `latency` (ms per call), `realtimeDelay`, `defaultLimit`, `maxLimit`, `totalCap`, `caseSensitive`, `start` (clock), `user`, `teams`.

With `mountManifest()`, pass the fake (or its options) as `appwrite` and load the data plugins:

```js
const { $$, fake } = await mountManifest({
    appwrite: { databases: { main: { tasks: rows } } },
    manifest: { appwrite: { projectId: 'p', endpoint: 'https://example.test/v1' }, data: { tasks: { appwriteDatabaseId: 'main', appwriteTableId: 'tasks' } } },
    plugins: ['node_modules/mnfst/lib/manifest.data.js', 'node_modules/mnfst/lib/manifest.appwrite.data.js'],
    html: '<ul x-data><template x-for="t in $x.tasks" :key="t.$id"><li x-text="t.title"></li></template></ul>'
});
```

### Fixtures: `mnfst-test/fixtures`

Deterministic rows (seeded random, one-minute timestamps), so screenshots stay stable:

```js
import { heavyTenant, emptyTenant, makeRows } from 'mnfst-test/fixtures';

const schema = { main: { tasks: (i, { words, int }) => ({ title: words(2), priority: int(1, 5) }) } };
const heavy = heavyTenant(schema, { rows: 5000 }); // createFakeAppwrite options
const empty = emptyTenant(schema);
```

---

## Golden journeys: `mnfst-test journeys`

Requires puppeteer. A journeys file lists the paths a user must always be able to walk:

```js
// journeys.mjs
import { heavyTenant, emptyTenant } from 'mnfst-test/fixtures';

const schema = { main: { tasks: (i, { words }) => ({ title: words(2) }) } };

export default {
    root: '.',                       // served locally; or pass --base-url
    viewport: { width: 1280, height: 800 },
    journeys: [
        { name: 'empty workspace', fake: emptyTenant(schema), async steps(j) {
            await j.waitForData('tasks');
            await j.snap('empty');
        } },
        { name: 'busy workspace', fake: heavyTenant(schema), async steps(j) {
            await j.waitForData('tasks');
            await j.snap('list');
            await j.fake.table('tasks').insert({ title: 'Live row' }); // realtime from another user
            await j.page.waitForFunction(() => document.body.textContent.includes('Live row'));
        } }
    ]
};
```

```bash
npx mnfst-test journeys journeys.mjs --update   # write baselines
npx mnfst-test journeys journeys.mjs            # compare
```

The runner answers the page's Appwrite SDK `<script>` with the fake, so the real Manifest plugins run on fixture data. A journey fails on a thrown step, a screenshot that differs from its baseline (the actual and a diff image land in `__screenshots__/__diff__/`), a missing baseline under `--ci` or `CI`, or any console error. Baselines are per platform (`name-darwin.png`, `name-linux.png`) because fonts render differently.

Each journey gets `page` (puppeteer), `fake` (the in-page backend: `table()`, `calls()`, `lastQueries()`, `failNext()`), `x(expr)` (evaluate an Alpine expression), `settle()`, `waitForData(source)` and `snap(name, { selector, fullPage, mask })`. Use `launch()` from `mnfst-test/browser` to drive the same thing from Vitest.

Config keys: `root` or `baseURL`, `journeys`, `fake` (default for every journey), `viewport`, `snapshots`, `threshold` (per-channel, default 0.1), `maxDiffPixels` (default 0), `mounts` (`{ '/lib/': dir }`), `routes` (`[{ url, file | body }]` to answer requests), `failOnConsoleError`.

### Against staging

Run the same journeys against a deployed staging site after each landing:

```bash
npx mnfst-test journeys journeys.mjs --base-url https://staging.example.com --ci
```

Journeys with a `fake` still use fixture data there, so screenshots compare the deployed code against the baselines. Journeys without one hit the real staging backend; keep those to behaviour checks without `snap()`, since real data changes.

---

## Testing strategies in a Manifest project

Three layers, each best served by a different tool:

| Layer                  | Tool                       | Covers |
|------------------------|----------------------------|--------|
| Project validation     | `mnfst-test` (this CLI)   | Typo'd tags, dead sources, syntax errors, console errors, a11y, broken links |
| Component-level logic  | `mountManifest` + Vitest   | Alpine `x-data` factories, prop merging, `$x` interactions in isolation |
| Data logic             | `createFakeAppwrite`       | Queries, paging, writes, realtime, against one shared fake |
| Golden journeys        | `mnfst-test journeys`      | Real browser, fixture tenants, screenshot diffs, staging runs |
| End-to-end behavior    | Playwright                 | Routing, multi-page flows, real network, real browser |

Use `mnfst-test` to lint the project as a whole, `mountManifest` and the fake for fast unit-style tests, and journeys for what users actually see.
