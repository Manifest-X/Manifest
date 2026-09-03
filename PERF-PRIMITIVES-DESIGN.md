# Performance Primitives — design RFC

Status: **v1 draft, 2026-08-27** — frozen for Phase 1 fan-out once Andrew signs
off. Origin: Playcom v4 brief (12.9s blocked first-open, 3.4s warm switch,
92k mutations/8s) + Playcom's answers to the seven pre-commit questions.
Coordinator: manifest-repos session. Validation partner: Playcom staging
(A/B worktrees Perf-Base/Perf-Fix, pin via `mnfst@next`).

## 0. Decisions already made

| # | Primitive | Verdict | Phase |
|---|---|---|---|
| P1 | `$computed` — cached, auto-tracked derivation | IN | 1 |
| P2 | automatic deferral of closed containers (popover/dialog/details/tabpanel/hidden) + `x-defer` for the rest | IN | 1 |
| P6 | `$x` landing coalescing + per-source versioning + identity-preserving upsert | IN (added by us) | 1 |
| P4 | Bless `x-virtual` (docs, scaffolds, dev warning) | IN | 2 |
| P5 | Stale-first `$x` reads with `$fresh` | IN | 2 |
| P3 | Scheduled flush | DEMOTED — see §6; spike only, evidence-gated | 3 |

Name: `$computed`, not `$memo` (Vue/MobX/Angular/Preact lineage; the engine
under Alpine IS `@vue/reactivity` whose primitive is literally `computed`;
no React dep-array connotation for AI authors). Playcom: no objection.

Ethos check: every item is additive, attribute-first, buildless, and applies
to any Manifest app. No VDOM, no compiler.

## 1. Ground truth from the source (what the brief couldn't see)

1. **Alpine ships unmodified from CDN at `latest`** (`manifest.js`
   `DEFAULT_VERSION='latest'`, `data-alpine` default `'3'`). The scheduler is
   module-internal. There is no "patch the flush" — see §6 for the only
   viable route.
2. **`$x` landing = whole-store replacement.** `updateStore()`
   (`manifest.data.js:299`) spreads the entire `Alpine.store('data')` into a
   new object, bumps a single global `_dataVersion` ("so any effect that read
   the store re-runs"), and rebuilds the cross-source `all` array on EVERY
   landing. The `$x` proxy read path subscribes to `_dataVersion`
   (`manifest.data.js:~8366-8395`). Net: one page of `chats` landing re-runs
   every consumer of every source. This is the 92k-mutation multiplier, and it
   was added deliberately as a hammer for stuck bindings (almost certainly the
   Alpine swallow bug, §6).
3. **Landings replace row references** (`createReactiveReferences` on each
   landing) — so row identity does NOT currently survive a page landing.
   Playcom's anti-flicker work depends on identity-stable rows; today they
   get that only from their own store, not from `$x`.
4. **Local writes vs network landings share one path.** Optimistic
   `addEntryToStore` / `updateEntryInStore` (`manifest.data.js:~2090-2180`)
   and network landings both funnel through store replacement. P6 must
   separate them (Playcom item 5: read-your-writes for local mutations).
5. No naming collisions: no `x-defer`, `$computed`, or `computed` magic exists
   (27 magics registered; x-virtual has no `defer` modifier — the memory note
   suggesting one was loose).
6. Test surfaces: vitest (`tests/**/*.test.js`, node env; happy-dom for DOM
   tests), puppeteer already a devDependency, test project at `src/` with
   demo components registered in `src/manifest.json` and routed from
   `src/index.html` (`x-virtual-demo` is the pattern to copy).

## 2. Shared metrics (Playcom's canonical definitions — assert these on BOTH sides)

- **Blocked time** = sum of `longtask` entry durations
  (`PerformanceObserver`, `type:'longtask'`) from gesture start to settle.
  Never wall clock.
- **Gesture start** = `performance.now()` captured in a capture-phase
  `pointerdown`/`click` listener.
- **Settle** = 500ms of `MutationObserver` quiescence on `document.body`
  (childList+subtree+attributes); window end = last mutation before that gap.
- **First-open** = gesture on a row never opened this session → settle of the
  detail pane. **Warm switch** = same, previously opened.
- **Input latency (menus)** = gesture → first paint after the popover
  `toggle` event (rAF after handler), plus blocked time over settle.
- **Mutation volume** = MutationObserver record count over the window.
- **Settle caveat (found by the Phase 0 harness):** body-wide quiescence
  never arrives under continuous background realtime writes — the window
  runs to the hard cap and blocked time inflates with unrelated work. Amend,
  and sync with Playcom before comparing numbers: the probe observes the
  GESTURE TARGET's subtree (detail pane / menu) for settle, and background
  writes are paused during a gesture window unless the scenario is
  explicitly measuring their cost.
- **Budgets (Playcom item 7):** deferred popover first open ≤100ms target,
  250ms hard ceiling. Prewarm never runs during boot (after first route
  settle only). Prewarm priority: command menu → country pickers → emoji
  grid → members menu.

Playcom's CI gate this week is STATIC (shape rules: no ungated `x-for`
collections in closed popovers, `:key` required; will accept `x-defer` as a
pass). Runtime metrics CI lives on OUR side first (§7).

## 3. P1 — `$computed`

**Status: SHIPPED to master (c06467c, 2026-09-01)** — `src/scripts/manifest.computed.js`,
`tests/computed.test.js` (6 tests on real Alpine 3.17.1), loads by default,
`$computed` magic + `window.$computed`, typed in `manifest.d.ts`. Verified in
the browser on both the explicit-script path and the loader derive path
(`src/test/computed.html`). Implementation note: eager-computed — the backing
effect recomputes on dependency change and writes the property, so readers
subscribe to the property itself; the effect is created during interceptor
init (before child directives), which keeps it ahead of its readers in
Alpine's flush order and clear of the swallow bug for init-time dependencies.

### API
```js
Alpine.data('inbox', () => ({
  rows: $computed(function () {            // `this` = the component's reactive scope
    return this.$x.chats.filter(c => c.open).sort(byRecent)
  }),
}))
```
```html
<div x-data="{ q: '', hits: $computed(function () { return $x.people.filter(p => p.name.includes(this.q)) }) }">
```
- Reads as a plain property (`rows`, not `rows()`); no dependency arrays —
  dependencies are tracked automatically at property grain.
- Returns the **same value identity** until a tracked dependency changes.
- Recompute happens **once per flush** on change (eager-computed), never once
  per binding read. That is the whole win: 203 getters × N bindings → 203
  recomputes max, and only for the ones whose deps moved.

### Implementation (idiomatic Alpine — the `$persist` mechanism)
- `$computed(fn)` returns an **Alpine interceptor**
  (`Alpine.interceptor((initialValue, getter, setter, path, key) => …)`).
  At component init Alpine calls `initialize(data, path, key)` with the
  REACTIVE data object — that solves the `this`-before-proxy problem cleanly
  and is exactly how `@alpinejs/persist` works.
- `initialize` defines the property as a getter backed by an `Alpine.effect`
  that re-runs `fn.call(data)` when deps change and stores the result; the
  getter returns the stored value. Release the effect on component destroy
  (`Alpine.release`, hook on `x-data` cleanup).
- Expose both: `window.$computed` (for `Alpine.data` factories) and
  `Alpine.magic('computed')` (for inline `x-data`).
- Ships as `manifest.computed.js` (subscript pattern; terse comments,
  toasts.js as the style reference) — or inside `manifest.utilities.js` if
  <80 lines. Coordinator's call at implementation.

### Contracts (document as law)
- **Identity contract:** the memoized OUTPUT (usually an array) must not be
  mutated in place — return new arrays; the memo makes that affordable.
- **Row objects may be mutated in place** and MUST NOT need replacement to
  invalidate — Vue tracking is property-grain, so `Object.assign(row, set)`
  invalidates exactly the computeds that read those fields. This answers
  Playcom item 6: new ARRAYS yes, new ROW OBJECTS never required.
- A computed that throws leaves its previous value in place and reports via
  `$try`-style console diagnostics (never a blank list).

### Tests
- `tests/computed.test.js` (happy-dom): recompute-once-per-flush, identity
  stable across unrelated writes, property-grain invalidation via in-place
  row mutation, `this` binding in both `Alpine.data` and inline `x-data`,
  release on destroy, throw-keeps-last-value.

## 4. P2 — deferred subtrees: automatic for closed containers, `x-defer` for the rest

**Status: SHIPPED to master (merge bf5b2aa, 2026-09-01)** —
`src/scripts/manifest.defer.js` (268 lines), 17 tests across three files
(happy-dom on real Alpine; popover API stubbed via dispatched
`beforetoggle`/`toggle`), verified in real Chrome on `/perf`, `/dropdowns`,
`/combobox` (26 checks) and on a prerendered route. Probe: menu-open input
latency at parity (~90ms, ≤100ms target met); boot blocked −280…−450ms on
the demo with 15/31 candidate containers deferred. Implementation
deviations, all accepted:
1. `[hidden]` EXCLUDES `[x-route]` — the router hides inactive routes with
   `hidden` at DCL, so every inactive route would have been deferred. That is
   a route-level decision and potentially a LARGE win (whole inactive pages
   hold no bindings); tracked as a Phase 2 candidate, not done here.
2. Containers carrying a child-owning directive (`x-html`, `x-text`,
   `x-virtual`, `x-colorpicker`, `x-date`, `x-text-edit`, `x-chart`, …) are
   never deferred — they render their own children.
3. Empty containers are not registered (tooltip singletons, datepicker
   shells).
4. Without the loader there is no `manifest:ready`; prewarm then starts on
   window `load`. Loader projects are unchanged.
5. `requestIdleCallback` carries `timeout: 1000` so a never-idle page still
   drains ≤1 container/s.
6. Combobox and datepicker generated menus opt OUT (`x-defer.off`) —
   imperative content; deferring them broke filter-while-closed/calendar refs.
7. Render pass sets `window.__manifestRender = true` so prerendered output
   keeps eager markup; the interceptor adopts a serialized stash template on
   hydration.
Plugin hook for docs: `manifest:defer-render` fires on the container after
its children initialize (dropdowns use it to apply `role=menuitem` off the
gesture — that alone was ~70ms on a 243-row menu).

### The rule (v2, 2026-09-01 — supersedes "defer-by-default in menu primitives")

Deferral keys on **closedness, not data**. We never need to know where a
project puts its data or which plugins it uses: a subtree inside a container
the platform reports as closed is invisible by definition, and every binding
in it is pure cost until it opens. So the framework defers **every closed
container automatically**:

| Container | Closed when | Open signal |
|---|---|---|
| `[popover]` — bare or any value (`auto`/`manual`/`hint`): menus, popover dialogs, tooltips, pickers | always at init (a popover cannot start open) | `beforetoggle` with `newState === 'open'` |
| `<dialog>` | no `open` attribute | `beforetoggle`/`toggle` (modern engines); fallback `Alpine.onAttributesAdded` for `open` |
| `<details>` | no `open` attribute | `toggle` |
| `[x-tabpanel]` | not the initially selected panel | tab selection (tabs plugin sync) |
| `[hidden]` | attribute present | `Alpine.onAttributeRemoved(el, 'hidden')` |

NOT automatic — opt-in with `x-defer`: `x-show` subtrees (their state usually
must exist while hidden, and the expression can't be pre-evaluated cheaply),
custom-visibility containers, and anything an author wants deferred for a
reason other than closedness. Opt-out: `x-defer.off` on the container, or a
global `data-defer="off"` on the loader script (soak/bisect kill switch).

What this does NOT cover, on purpose: content that is on the page and simply
below the fold. That is `x-virtual`'s job (P4), and `content-visibility:
auto` is a paint-only companion (it does not stop bindings) — optional P4
add-on for x-virtual rows, not part of P2.

### Mechanism — no scanning

There is no DOM scan. Alpine already walks every element at start and on
every dynamic insert — `x-for` clones, mutation-added nodes, and every
plugin's own `Alpine.initTree` call (components, charts, colorpicker,
dropdowns already use it). `Alpine.interceptInit(cb)` — public API, present
in the CDN build we serve today (3.17.1) — runs `cb(el, skip)` for each
element BEFORE that element's directives are processed. Our interceptor
costs two property reads per element (`hasAttribute('popover')`, a tagName /
`open` check; ~100ns — roughly 5ms across 50k elements, on a walk whose
directive work costs orders of magnitude more).

For a closed container it: moves the children into an internal `<template>`
inside `Alpine.mutateDom` (so Alpine's mutation observer ignores the move —
the same trick `x-if` uses), wires the open signal, and calls `skip()` so the
children are never walked. The container's OWN directives still run
(`x-dropdown` wiring, an `x-data` on the menu, aria sync).

**Cooperative registration.** Plugins that construct closed containers at
runtime call `Manifest.defer(el)` before their own `Alpine.initTree(el)`:
dropdowns' template-clone/body-append path, tooltips, combobox, datepicker,
colorpicker. `manifest.dropdowns.js` must set `popover` BEFORE `initTree` on
the template branch (today it initTrees first, then `setupDropdown` sets the
attribute — a one-line reorder). Authored `<menu popover id="…">` — the house
style in every demo — needs nothing at all.

### Semantics (modifiers apply to automatic and explicit deferral alike)

```html
<menu popover>…</menu>                             <!-- automatic: render on first open, keep-alive, idle prewarm -->
<menu popover x-defer.lazy>…</menu>                <!-- no prewarm; render strictly on first open -->
<div x-tabpanel="settings" x-defer.discard>…</div> <!-- teardown on hide, re-render on show -->
<menu popover x-defer.priority="1">…</menu>        <!-- prewarm first (lower = earlier) -->
<menu popover x-defer.off>…</menu>                 <!-- keep eager -->
<div x-show="open" x-defer>…</div>                 <!-- explicit opt-in for x-show -->
```

- Default = defer + keep-alive + idle prewarm. (The brief's `.eager` is
  dropped — it contradicted its own prose.)
- **Prewarm** starts on `manifest:ready` (the loader's "page visually
  settled" event — data ready, utilities idle, markdown idle, quiet timer)
  and drains through `requestIdleCallback`, one container per idle slice,
  `.priority` ascending then document order. Never before `manifest:ready`
  (Playcom: never during boot). Budget: first open ≤100ms target / 250ms
  ceiling, measured by the harness `menu-open` scenario.
- **Render on `beforetoggle`** (synchronous, before the popover paints) so
  anchor positioning and dropdowns' `toggle` handler see real content.
- Keep-alive means inputs keep their state across close/open; `.discard`
  (`Alpine.destroyTree` on close) is the exception for genuinely throwaway
  panes.
- `$refs` inside a deferred subtree resolve after first render (document;
  optional chaining is the house norm). Ids referenced from OUTSIDE
  (`aria-controls`, `popovertarget`) belong on the container, which is never
  deferred itself.

### Prerender contract (mandatory — the brief missed it)

`mnfst-render` output MUST contain the deferred subtree's markup (SEO,
no-JS content). On hydration the interceptor detaches it into the template
before any child directive initializes, then proceeds identically to the SPA
path. Acceptance: identical behavior on the SPA route and its prerendered
twin (`src/test-prerender`).

### Interplay

- `x-virtual` inside a deferred container initializes on open; its
  "defer until sized" logic already tolerates late mount.
- `x-teleport`ed popovers: the teleported clone goes through `initTree`, so
  the interceptor applies.
- Edit plugin: a deferred subtree is not editable until opened — matches the
  user's expectation (you edit what you can see); the editor canvas opens
  containers to edit them.
- Playcom's five hand-fixed menus map to plain authored `<menu popover>`
  once this lands — i.e. their fix becomes deleting code.

### Tests

- `tests/defer.test.js` (happy-dom): automatic detection per container type;
  no child directive runs while closed; render on `beforetoggle`; keep-alive;
  `.discard`; prewarm only after `manifest:ready` and in priority order;
  `.off` + global kill switch; cooperative path (template-clone dropdown);
  prerender hydration parity via the test-prerender fixture.
- Harness: `menu-open` blocked time while closed ≈ 0; first open ≤100ms with
  prewarm; boot blocked time unchanged or lower with 4×243-row menus present.

## 5. P6 — `$x` landing model

**Status: SHIPPED to master (merge 3fd8c12, 2026-09-01)** — subscripts
`core/manifest.data.store.js`, `shared/manifest.data.{main,mutations,
proxies.appwrite,proxies.magic.core}.js`; `tests/data-landing.test.js` (27
tests, real subscripts via vm on real Alpine); harness `?source=x` mode +
`scripts/perf/landing.mjs`. Internal API: `landRows(source, rows, {mode})` /
`landRemove` / `flushLandings` for the network path (one flush per frame,
awaitable); `updateStore` + the mutation functions stay synchronous local
writes; `_v[source]` per-source versions (`_dataVersion` kept only for
status/datepicker/charts readers); `$x.all` is real and lazy. **Zero
whole-store replacements remain in the data layer.** Playcom-shaped numbers
(before → after): cold switch 9,134 → 486 mutations; warm switch 5,055 →
448; single-row local write 4,910 → 44 (0ms blocked); 9 page landings
85,244 → 5,717 mutations; realtime upserts 57,571 → 583 mutations, 1,341 →
0ms blocked. Deviations, accepted:
1. Optimistic create ack (temp → real `$id`) replaces that row object in
   place (`$files` is bound to `$id`); array identity kept.
2. `$id`-less rows (CSV/YAML/JSON) are not merged positionally on replace —
   fresh objects, as before.
3. A cache-miss RELOAD of an already-landed source still writes `null` +
   `loading:true` first, dropping row identity — P5 stale-first territory.
   Playcom's per-switch row landing must arrive via realtime/`$update`, not
   a reload, to benefit (flagged to them).
4. The post-settle render-ready hammer (`bumpAllVersions`) now arms only on
   landings carrying an explicit load state; realtime landings never arm it
   (on HEAD every landing armed it, doubling its cost).
5. **Behaviour change (found by Playcom in production use):** local-only
   fields an app sets on a row (e.g. an optimistic placeholder's
   `_pending: true`) SURVIVE landings — the server row merges into the same
   object and never sends the field, so it is not cleared. Apps that relied on
   wholesale replacement wiping local flags must clear them explicitly on
   success. Documented in the data articles ("How data updates").

Three changes to `updateStore` and friends, all internal, no API change:

1. **Per-source versioning.** Replace the single `_dataVersion` subscription
   with `_v[source]`; the `$x` proxy read for `chats` subscribes to
   `_v.chats` only. Landings for `contacts` no longer re-run `chats`
   consumers. `all` becomes lazily built on first read of `$x.all` and
   versioned by its own counter.
2. **Landing coalescing.** Network landings (page loads, realtime batches)
   are buffered and applied once per animation frame (or per batch promise
   resolution — whichever is earlier) as a single store write. **Local
   writes (optimistic create/update/delete, rollback) stay synchronous** —
   read-your-writes preserved (Playcom item 5). `$nextTick` semantics after a
   local write are unchanged.
3. **Identity-preserving upsert.** A landing merges rows by `$id` into the
   existing reactive row objects (`Object.assign` on the tracked proxy) and
   appends only genuinely new rows; the source array keeps its identity on
   append. Rows survive landings → `x-for`/x-virtual reconciliation is free,
   Playcom's anti-flicker requirement is met AT the framework layer.

Ordering guarantees to document: within one coalesced flush, landings apply
in arrival order; a local write that races a landing for the same `$id` wins
(local-last), with the landing's fields merged beneath it.

Playcom's same-tick list (item 5) becomes the regression suite:
optimistic-write-then-read, `$nextTick` DOM read after state write,
read-modify-write chain on a blob field, `x-route`/`x-show` flip in one flush.

Boot: the `/v1/account ×22` storm was OURS — `loadTableRows` in
`src/scripts/data/appwrite/manifest.data.appwrite.js` ran a fresh
`Account(client).get()` pre-flight on EVERY table load (16 in one tick = 16
sources booting). **Fixed 2026-08-27** (shared in-flight check, pass cached
until an `manifest:auth:*` event; `tests/data-auth-preflight.test.js`). Ships
with the first `mnfst@next` RC. P5 adds general request dedupe in `$x` later.

## 6. P3 — what "scheduled flush" can actually mean here

Alpine's `queueJob`/`flushJobs` are module-internal and Alpine is loaded
unmodified from CDN. The ONLY sanctioned seam is
`Alpine.setReactivityEngine({ reactive, effect, release, raw })`, called
before `Alpine.start()`. A custom engine supplies its own `effect`, and
therefore its own scheduler — Alpine passes its internal `queueJob` as
`options.scheduler`, but the engine is not obliged to use it.

So P3, if pursued, is **an opt-in replacement reactivity engine plugin**
(`manifest.scheduler.js`, bundling `@vue/reactivity` ≈10KB gz) whose jobs,
in order:

1. **Correctness first: fix the swallow.** Alpine 3.x dedupes queued jobs
   with `queue.includes(job)` against the already-run segment of the current
   flush, so a re-trigger of an already-flushed effect is dropped — this
   strands `x-for` when a sibling effect creates state mid-flush. We mitigate
   it today with `$chat.version` and (see §1.2) the global `_dataVersion`
   hammer. A custom scheduler dedupes only against the not-yet-run segment.
2. **Timing-identical by default** (microtask flush, `$nextTick` runs after
   effects). Zero behavior change on install — that is the soak.
3. **Yielding as a later opt-in** (`data-scheduler="yield"`): between
   top-level component subtrees only, never mid-component, so tearing is
   bounded to component seams. Only if post-Phase-1 numbers show residue.

Risks: two `@vue/reactivity` copies (Alpine's dead one + ours), engine must
be installed before ANY reactive is created (loader-ordered), `Alpine.raw`
identity across engines. This is a Phase 3 SPIKE with a go/no-go, not a
commitment. Prediction: P1+P2+P6 remove the need for step 3; step 1 alone
may justify the plugin.

## 7. Phase 0 — harness (blocks fan-out)

- `src/test/components/perf-demo.html` registered in `src/manifest.json`,
  routed as `x-route="perf"` in `src/index.html`. Synthetic Playcom shape,
  parameterized via query string (`?menus=4&rows=243&emoji=169&getters=40&
  pages=10&pageSize=100&cadenceMs=80`): 4 closed popover menus of 243 rows,
  2 × 169-item grids inside a 5-tab command menu, a 100-row grid evaluating
  30–60 getters/row, and a fake paged source landing 100 rows/page with
  APPEND shape plus periodic in-place row upserts. Row-open and menu-open
  gestures exposed as buttons with stable ids.
- `scripts/perf/probe.mjs` (puppeteer, already a devDependency): drives the
  test project, implements §2 verbatim, prints JSON
  `{ scenario, blockedMs, longestTaskMs, mutations, inputLatencyMs }` for
  first-open, warm-switch, menu-open; `--budget` flag asserts thresholds
  (non-zero exit) for CI. Playcom will run the SAME probe module against
  staging once their runtime CI lands — so keep it app-agnostic (selectors
  via config).
- Baseline numbers recorded in this doc before any primitive lands.

## 8. Phase plan, ownership, models

| Phase | Work | Model | Isolation |
|---|---|---|---|
| 0 | Harness + baseline | Sonnet 5 (review by coordinator) | new files only |
| 1a | `$computed` — DONE c06467c | Fable | coordinator session |
| 1b | `x-defer` + automatic deferral + prerender parity — DONE bf5b2aa | Fable | worktree agent |
| 1c | P6 landing model — DONE 3fd8c12 | Fable | worktree agent |
| 2 | P4 docs/warning, P5 stale-first + `$fresh` + request dedupe | Sonnet 5 | any |
| 3 | P3 engine spike, go/no-go | Fable | worktree |

Release: RCs publish under `mnfst@next` (add `release:next` script = bump +
`npm publish --tag next`; Andrew's browser-auth step as always). Playcom pins
same-day, reports per-primitive numbers against Perf-Base with hand fixes
reverted (agreed A/B protocol).

Docs to update on ship: data plugin article (landing model, stale-first),
new `$computed` + `x-defer` articles, x-virtual posture in layout/data
articles, llms.txt regeneration, `manifest-performance` connector skill
(agents apply computed/defer/virtual by default) — Phase 2.

## 9. Open items

- **Probe (§2 amendment, now urgent):** body-wide settle absorbs x-defer's
  prewarm slices (~55ms each, a 243-row x-for render), inflating
  `first-open` mutations to ~7k and its blocked time in quiet mode. Move
  settle to the gesture target's subtree and pause background writes during
  a gesture window — Phase 2, before the RC A/B numbers are compared.
- **Route-level deferral** of inactive `[x-route]` subtrees (see §4
  deviation 1) — Phase 2 candidate with its own soak; the router owns it.

- Playcom: Chrome performance profile of Perf-Base first-open (item 3) —
  for attribution verification, not blocking.
- Andrew: sign-off on this RFC → Phase 1 fan-out; ratify `$computed` name;
  approve adding `@vue/reactivity` bundling IF Phase 3 spike goes ahead.
- Coordinator: after Phase 1 lands, remove the `_dataVersion` hammer and the
  `$chat.version` mitigation only if the §6 engine ships; otherwise keep.

## 10. Baseline (Phase 0, 2026-09-01)

Recorded with `npm run perf` (`scripts/perf/probe.mjs`, 3 samples per scenario,
median reported) against `src/test/components/perf-demo.html` at
`/perf`, default params: `menus=4&rows=243&emoji=169&getters=40&pages=10&
pageSize=100&cadenceMs=80&upsertEveryMs=200`.

Machine: Apple M5 Pro (arm64), macOS 26.6.2 (25G83). Puppeteer 24.43.1,
bundled Chrome/148.0.7778.97 (headless). Node v22.11.0.

| Scenario | blockedMs | longestTaskMs | mutations | inputLatencyMs |
|---|---|---|---|---|
| first-open | 172 | 63 | 880 | — |
| warm-switch | 0 | 0 | 398 | — |
| menu-open | 5519 | 81 | 154 | 89.5 |

Notes:
- `menu-open`'s settle window rarely closes within the 500ms quiescence
  target because the demo's `upsertEveryMs=200` background realtime writes
  keep `document.body` mutating — the probe falls back to its 15s hard cap,
  so `blockedMs` there is dominated by many small longtasks from the
  `conversations` getter re-deriving on every upsert that touches one of its
  last-60 rows, not by the click itself. This is the §1.2 "every consumer
  re-runs" cost showing up organically, not a harness bug — it is exactly
  the shape P6 (landing coalescing + per-source versioning) targets. Re-run
  after Phase 1 lands to see it collapse.
- `warm-switch` is already near-zero because the demo keeps opened
  conversation panes mounted (`x-show`, not `x-if`) — this models the
  keep-alive half of `x-defer`'s benefit; the getter grid and closed popover
  menus (unaffected by this scenario) remain fully eager pre-Phase-1.
- Run-to-run variance observed: a second run measured `first-open` ≈119ms,
  `menu-open` blockedMs ≈5394 / inputLatencyMs ≈82ms — same order of
  magnitude, not a fixed constant. Treat these as a baseline range, not an
  exact regression threshold, until Phase 1 numbers are in.

### 10.1 Playcom staging baseline (2026-09-01, signed-in operator, ~50 chats, §2 definitions)

The numbers Phase 1 is judged against (per-switch is the lever for how the
app FEELS — Andrew eyeballed staging and called the app-side hand fixes
"barely registered"; this explains why):

| Scenario | wall | longtask | mutations |
|---|---|---|---|
| Boot | — | 10.9s blocked (52 long tasks, longest 573ms) | — |
| Cold first open, 5-message thread | 3.7s | 2.7s | 12,085 |
| Switch to another cold thread | 3.4s | 2.4s | 14,288 |
| **Warm re-open (transcript in memory, zero network)** | immediate reveal | **2.6s** | **12,252** (never reached quiescence in 25s) |
| Thread warmed by idle prefetcher | 99ms | 125ms | 164 |

Reading: rendering 5 messages costs ~164 mutations; everything above that is
the per-switch global re-render (§1.2: whole-store replacement + global
`_dataVersion` + `all` rebuild). Idle DOM with no gesture = 0 mutations, so
it is landing-driven, not a ticker. **P6 acceptance:** warm-switch mutations
approach the thread's own render cost (hundreds, not ~12k); a landing for one
source never re-runs consumers of another. Repro shape for `/perf` `$x`
mode: ~50 nav rows × ~15 `$x` bindings, a ~40-binding context panel, one
thread pane; switch chats and count. Playcom keeps tonight's tree pinned as
Perf-Base for the RC A/B.

Addendum (same session): a single-field LOCAL write on one contact row
(country toggle, cache patched in place) still costs ~1.6s longtask on a
50-row page — the same floor reached through the local write path
(`updateEntryInStore` → whole-store replacement). P6 acceptance therefore
also covers local writes: a one-field write on one row re-runs only that
row's/source's consumers; never the store. Perf-Base pinned: Playcom-Platform
tag `perf-base-sep2` (9bc0c058, staging `?v=c5dcfa9f36dd`); scenario = rows
5/6 prefetched-vs-cold, row 20 cold, row 21 cold, reopen row 20.

### 10.2 Post-Phase-1 (master 3fd8c12, all three primitives, `/perf?source=x&upsertEveryMs=100000`)

| Scenario | mutations | blockedMs | note |
|---|---|---|---|
| first-open (cold switch) | 5,948 | 119 | includes x-defer prewarm slices in the body-wide settle window (§9); the bare gesture measured 486 on the P6 branch |
| warm-switch | **448** | **0** | was 5,055 |
| menu-open | 0 | 0 | inputLatencyMs 124 this run vs ~90 on the 1b branch — re-check variance/prewarm timing before the A/B |
| local-write (one field, one row) | **44** | **0** | was 4,910 / ~80ms |

For the Playcom A/B: **blocked time is the fair metric** for gesture windows
measured within ~15s of `manifest:ready` — mutation counts will include
prewarm slices until they drain (≤1 container/s). Pin the RC with
`data-version="<x.y.z-next.n>"` on the loader script; the RC is a
prerelease under the `next` dist-tag (`npm run release:next`), so `latest`
stays clear for the real release.

### 10.3 RC published — `mnfst@0.5.198-next.0` (dist-tag `next`, 2026-09-02)

Contains P1 + P2 + P6 + the account pre-flight dedupe on top of 0.5.197.
Verified: npm dist-tags `latest=0.5.197`, `next=0.5.198-next.0`; jsDelivr and
cdn.manifestx.dev both serve it (the pull-through treats the prerelease as an
exact immutable version). Playcom pins `data-version="0.5.198-next.0"` and
re-runs the `perf-base-sep2` scenario. Gate for promoting to a real release:
their table + no functional regressions from the soak.

### 10.4 Playcom A/B — local serve, A = perf-base-sep2 @ 0.5.197 (hand gates in), B = RC (gates reverted)

Same copies, staging Appwrite, QA Manager / Acme Demo (53 rows), sequential.
Their nav's 1s age ticker never lets the DOM go quiet (`x-text` rewrites
unchanged strings — ~1,150 mutations/s in A), so gesture windows are fixed 8s
and blocked time is the metric.

| Scenario | A blocked / mutations | B blocked / mutations |
|---|---|---|
| Boot (22s, long tasks) | 12,493ms / 52 tasks, longest 599 | **4,805ms (−62%)** / 32, longest 260 |
| GET /v1/account at boot | 12+ | **2** |
| Idle 3s | 0 / 3,576 | 0 / **959** |
| Cold switch #1 | 6,394 / 56,024 | 3,145 / 8,311 (18 rows-list fetches — see below) |
| Cold switch #2 | 2,494 / 19,927 | **1,196** / 3,169 |
| Warm re-open | 1,976 / 17,346 | **836** / 3,286 |
| Prefetched thread | 2,964 / 19,140 | 1,677 / 3,360 |
| Single-row write (4.5s) | 2,211 / 15,425, flag @1,631ms | 1,123 / 2,476, flag @995ms (one ~1s task remains — theirs to profile) |

Functional: zero regressions, no `x-defer.off` needed, optimistic writes
visible same tick. Net: blocked time roughly halved everywhere, mutations
−80%, boot −62%. Not the harness-level collapse — residuals:

1. **Countries menu FIRST open 959ms vs 454ms with their hand `x-if` gate**
   (243 rows; container had just mounted on a tab click, prewarm hadn't
   reached it). Above the 250ms ceiling → **RC.1 fix: containers registered
   after `manifest:ready` are prewarmed URGENTLY (front of queue, ≤100ms
   idle timeout)**; and the real answer for a 243-row picker is `x-virtual`
   inside the popover (P4 posture — a plain 243-row x-for costs ~450ms even
   hand-gated).
2. **18 rows-list fetches on the first switch (A: 2).** Expected consequence
   of deferral: `$x` reads inside closed containers (tab panels, menus) used
   to fire their source loads at boot; now they fire on first render. Boot
   fetches 21 → 25 and later switches 2 in both. Document as a behavior
   change; prewarm normally absorbs it before the first gesture.
3. **`x-text` churn (P7 candidate):** Alpine's `x-text` writes `textContent`
   on every effect run even when unchanged → ~1,150 mutations/s from a 1s
   ticker over 53 rows. A Manifest equality guard on text writes is tiny and
   universal; app-side mitigation now is to tick at the rendered
   granularity (minute) or compare before writing.

### 10.5 RC.1 — `mnfst@0.5.198-next.1` (2026-09-02)

RC.0 + the urgent-prewarm fix (6d5540c): containers registered after
`manifest:ready` go to the front of the prewarm queue with a 100ms idle
timeout. Playcom re-measures only countries-first-open and cold switch #1.
Promotion gate: countries first open ≤250ms ceiling (≤100ms target), no new
regressions → `npm run release` (lands as 0.5.198).

### 10.6 RC.2 — `mnfst@0.5.198-next.2` (2026-09-02)

RC.1 + the three-way urgency gate (30e7ff1). Verified on registry and both
CDNs after a propagation grace. Promotion gate unchanged: quiet-machine boot
and idle window match RC.0 (idle = 0ms blocked), countries first-open ≤250ms,
no new regressions → `npm run release` (0.5.198).

### 10.7 RC.2 soak findings on Playcom's real tree → RC.3 (2026-09-02)

Driven directly (headless Chrome 148 via puppeteer, macOS M5 Pro): Playcom-Platform candidate tree — their staging tip **ea56b364** with the x-virtual pickers and minute-clock ticker, as reported by Playcom, copied to the "platform-cand" scratch folder (not a git checkout, so verify against ea56b364 rather than trusting the copy); loader src and data-version both pinned to 0.5.198-next.2 (confirmed in its index.html), served by `mnfst-run` on :61500; their Perf-Base is tag `perf-base-sep2` = 9bc0c058, guest sandbox on Acme Games, path guest → Inbox → Sven Novak → Contact → "Contact fields" kebab → "Set countries" (context-options-contact.html:96 → its menu ~:111). Numbers below are from that tree; re-check the commit before assuming a later tree matches.
- **"Empty scope at click" was a measurement artifact**: `Object.keys(Alpine.$data(el))`
  is always `[]` (the merge proxy has no property-descriptor trap); the
  scope was initialised. The 1s wait they saw was not reproducible on an
  idle machine: countries open = 44ms x-defer render + ~110ms browser
  show/layout + ~140ms of their `vReady` tick and x-virtual paint.
- **Prewarm did not work on a real app.** 446 deferred containers, 361 still
  pending after 12s: `requestIdleCallback` fired twice in 3s, both by
  timeout, 0ms idle — the page is never idle (~17fps, recurring 54ms tasks),
  so prewarm rendered one container per second, in document order, 209 of
  them under hidden routes and only 22 near the viewport.
- **RC.3 prewarm** (815a9ed, f007173, + gesture promotion): skip containers
  under `[x-route][hidden]`; rank by proximity of the container's invoker or
  nearest boxed ancestor to the viewport; batch only in genuine idle time
  (4ms budget, ≤8/slice), one render per forced fire at 500ms; a ROLLING
  cap of 48 warm-but-unopened containers (least reachable re-stashed via
  destroyTree → template; `ManifestDeferConfig.prewarmCap`); prewarm pauses
  at the cap and resumes when a warm container opens/evicts; on a pointer
  gesture (+150ms) the on-screen pending containers nearest the click are
  promoted to urgent (cap 8, authored `x-defer.priority` wins);
  `ManifestDefer.stats()` for diagnostics.
- Residual: a pane with more than eight candidate menus cannot be fully
  warmed within a human reaction time on a never-idle page; those open cold
  (Playcom's x-virtual countries: 161ms open / 320ms rows here). Authors pin
  hot menus with `x-defer.priority="1"`. Also: their popover open pays
  ~110ms of page-wide layout regardless of deferral — CSS containment on
  the heavy panels is their lever.
- x-virtual first paint moved off the ResizeObserver tick (was firing
  "ResizeObserver loop" error events).

### 10.8 Handoff checklist for the next Playcom session (their perf lane ended 2026-09-02)

Give this block to whichever Playcom session picks up the A/B after RC.3
(`mnfst@0.5.198-next.3`) is published:

1. Pin BOTH loader src and `data-version` to `0.5.198-next.3` on the A/B
   branch (`claude/perf-ab`), same rig and scenario as `perf-base-sep2`.
2. Add `x-defer.priority="1"` (modifier in the attribute NAME, number as the
   value — first authored `x-defer` in the tree) to EVERY twin of the countries
   menu: `components/context/context-options-contact.html` (~:111, the one
   the framework-side measurements used, reached via the "Contact fields"
   kebab → "Set countries" at :96), `components/context/
   context-contact-identity.html` (~:123 trigger), and the country list in
   `components/context/context-record-fields.html` (~:885). State in the
   table which path the operator clicked.
3. Re-run: boot; idle 3s (pass = 0ms blocked, mutations at RC.0 level);
   cold switch #1; countries first-open at 150ms and 1,000ms after the pane
   mounts; capture `window.ManifestDefer.stats()` at the countries click.
4. Known facts so they are not re-derived: `Object.keys(Alpine.$data(el))`
   is always `[]` (instrument artifact, scope is fine); ~110ms of every
   popover open on the Platform page is page-wide layout independent of
   deferral (CSS containment on the nav/panel scrollers is the lever);
   prewarm now targets on-screen, reachable containers nearest the last
   gesture and pauses at a rolling cap of 48 warm containers.

## 11. Phase 2 plan (opened 2026-09-02 after RC.3 `0.5.198-next.3`)

Coordinator runs code tracks with worktree agents; docs run in a separate
session (see §11.4). Order of value:

### 11.1 P5 — stale-first `$x` + request dedupe + reload keeps identity

**Status: SHIPPED to master (merge f3021c9, 2026-09-02)** — 19 tests
(`tests/data-stale-first.test.js`), suite 281/281. Reload of a landed source
keeps rows live and lands by `$id` (harness: 1,771 → 119 mutations, row and
array identity kept, one request). Dedupe key `source:locale` (locale `""`
normalised to `en`), `$query` keyed by its query list; every entry path goes
through the one map. `$stale` = true until the first network-fresh landing
this page-load; `$fresh` = one promise per source per page-load (never
rejects). Deviations: memory-cache hits do not background-revalidate (there
is no storage cache — a memory hit is already fresh; explicit reloads do);
`$query` does not flip `$loading`; API-URL sources still swallow a failed
reload into their default value (pre-existing, follow-up). P6 deviation 3 is
closed.
- **Reload keeps identity:** a cache-miss reload of an already-landed source
  must NOT write `null` + `loading:true` first. Keep the rows live, set
  `$loading` only, land the fresh rows through `landRows(replace)` (merge by
  `$id`, so row objects survive). Closes P6 deviation 3.
- **Request dedupe:** identical in-flight loads for the same
  source+query share one promise (the `loadingPromises` map exists — make
  it authoritative for every entry path: initial load, `$query`, reload,
  affected-table reloads).
- **Stale-first read:** `$x.<source>` renders cached rows immediately when a
  memory or storage cache exists and revalidates in the background;
  `$x.<source>.$fresh` is a promise (resolves when the first fresh landing of
  this page-load is applied) and `$x.<source>.$stale` a boolean for
  single-reveal UIs. No new manifest.json config.
- Tests: extend `tests/data-landing.test.js`; harness `?source=x` reload
  scenario before/after (identity preserved, one request per source).

### 11.2 `x-text` equality guard (P7)

**Status: SHIPPED (1db351e)** as the `bindings` default plugin.
Alpine's `x-text` assigns `textContent` on every effect run even when the
string is unchanged (Playcom: ~1,150 mutations/s from a 1s ticker over 53
rows; settle-based metrics unusable). Re-register the `text` directive on
`alpine:init` with an equality check before the write (same semantics
otherwise). Ships in `manifest.computed.js`? No — a directive override does
not belong in a magic plugin: new tiny default plugin `manifest.bindings.js`
(guard only; named `bindings`, not `text`, to avoid colliding with the text-edit plugin's `$text` magic), registered in `AVAILABLE_PLUGINS`, `copyFilesToDist`, the src
test project. Test: an unchanged re-evaluation produces zero MutationObserver
records. Coordinator does this one (small, Alpine-internal).

### 11.3 Probe amendment, cdn-warm retry, route-level deferral

**Probe + cdn-warm: SHIPPED (merge ec5e9ce).** `--settle-target` per
scenario (detail pane / menu / row container), `--pause-background` default
on, `--settle-body` for parity runs, `settle:` reported per line; first-open
mutations 1,850 → 482 (defaults) and 4,476 → 142 (`source=x`) with prewarm
noise gone. cdn-warm retries per URL with 5s→60s backoff, 5-minute cap.
- `scripts/perf/probe.mjs`: settle on the gesture target's subtree
  (`--settle-target <selector>` defaulting to the pane/menu the scenario
  opens), pause background writes during a gesture window, keep body-wide as
  an opt-in for parity runs. Sonnet.
- `scripts/cdn-warm.mjs`: retry each URL until the upstream serves the
  version (backoff, ≤5 min) instead of one immediate pass — three RCs, three
  transient 502s. Sonnet.
- **Route-level deferral** (from 1b deviation 1; hard evidence: 209 of 446
  deferred containers on Playcom sat under hidden routes): the router hides
  inactive `[x-route]` subtrees with `hidden`; deferring them means an
  inactive page holds zero bindings. Needs the router's cooperation (render
  on route activation, prerender parity, `$refs`/anchors across routes) and
  its own soak. Fable, after P5.

### 11.4 Docs (separate session)
Principle: **defaults live where the feature is used, mechanics live once.**
- Existing articles get one plain-language section each: Dropdowns/menus
  ("Closed menus cost nothing" — automatic; `x-defer.priority` for hot menus;
  `.off`), Tabs and Dialogs (one line each), Data ("How data updates" —
  per-source, rows keep identity, local edits show instantly, `$fresh`),
  Lists/x-virtual ("Big lists inside menus").
- New article **Computed values** (`$computed`) beside state/getters.
- New **Performance** guide in the developers/advanced family: mental model
  (closed containers, landings, computed), `x-defer` reference (modifiers,
  priority, kill switch, `manifest:defer-render`, `ManifestDefer.stats()`),
  diagnostics, the probe, "when it's slow" checklist. Feeds the
  `manifest-performance` connector skill and llms.txt.

### 10.9 RC.3 failed Playcom's gate → RC.4 (2026-09-02)

Playcom (A/B branch 53e4712e, RC.3 pinned, priority="1" on both real
countries menus): boot 6,967–8,047ms blocked vs RC.2 4,589 (+45–75%), idle 3s
272–1,425ms blocked (pass = 0), cold switch #1 5,369ms. Cause: on a never-idle
page every idle callback fired by TIMEOUT, so "one render per forced fire"
became a 500–700ms task every 500ms. **RC.4 (77f7eb6):** idle callbacks carry
no timeout and render only in reported idle time — a never-idle page gets no
background prewarm (its stashed containers cost nothing); gesture promotion
runs at +50/+150/+400ms and a new gesture restarts it. Validated on the
candidate tree (idle window quiet; warm/pending move only in genuine idle).
Lesson, as law: never give `requestIdleCallback` a timeout for optional work.

RESOLVED (Playcom, same day): the ~950ms countries open was an instrument
artifact — Chrome aligns timers in a HIDDEN document to 1s wake-ups once a
timer chain nests past depth 5, and their driven browser pane is not
displayed; the 5ms poll, their `vReady` setTimeout(0), and the post-mount
waits were all quantised to the next second. Timer-free re-measure (toggle
events + PerformanceObserver): cold open of the plain 243-row picker ≈ 90ms
of work. Standing from their RC.3 report: everything PerformanceObserver /
MutationObserver / stats()-based (boot +45–75%, idle-window blocked time,
cap disarm) — RC.4 remains the fix. Law for all measurements: in a hidden
document use events and observers only, never timers or rAF; and keep the
pane displayed or use headless Chrome.

Original note kept for the record: not reproducible here (both trees, defer on/off). A full
show/hide/attribute/removal trace on their A/B copy (guest session, real
pointer click) shows one closed→open transition at 232ms and no hide — the
plain 243-row picker's cold render. An in-page tracing snippet was handed to
them for their signed-in operator session; if a hidePopover/removal appears
between toggle:open and the late open, its stack names the culprit; if their
5ms poll itself gaps ~900ms, the wait is work under-reported by the longtask
observer.

### 11.5 Route-level deferral (spike, flag) — 2026-09-02

**Status: BUILT on a worktree branch, OPT-IN, default OFF.** Flag:
`data-defer-routes` on the loader `<script>` or
`window.ManifestDeferConfig.routes = true` (the test project maps
`?deferRoutes=1` to the latter). `data-defer="off"` still kills everything.
Flag off, the tree behaves exactly as today (suite 296/296; §4 deviation 1
stays in force).

**Design as built.**
- *Closedness comes from the router, not the attribute.* The interceptor
  asks `ManifestRoutingVisibility.isRouteActive(el)` (new; the router's own
  per-element match against the current logical path, `!*` included) and
  also accepts a present `hidden`. This matters because Alpine walks routes
  before the router hides them in two real cases: projects that link
  scripts directly (Alpine's CDN build starts on a microtask before DCL) and
  component roots, which the components plugin `initTree`s before it fires
  `manifest:components-processed`. The active route at load is never
  stashed; on prerendered MPA output `isRouteActive` is always true (that
  page only carries its own route), so hydration never stashes anything
  either — the `__manifestRender` kill already keeps the snapshot eager.
- *Activation hook.* The router now dispatches `manifest:route-activate` on a
  pane **before** it removes `hidden` / clears `display:none`; the defer
  plugin renders on that event, so the pane's first paint is complete (test
  asserts `hidden` is still present when `manifest:defer-render` fires; the
  probe's reveal observer sees all 100 rows at unhide). Fallback for any
  other unhide path: `Alpine.onAttributeRemoved(el, 'hidden')`. Chosen over
  attribute observation alone because Alpine's mutation flush is a microtask
  after the router has already made the pane visible and the router's own
  scroll/anchor work (setTimeout 50 / rAF + MutationObserver, 800ms fallback)
  would otherwise race an empty pane.
- *Keep-alive* by default (navigating back re-shows the same nodes, no
  re-init); `x-defer.discard` tears down when the router hides the pane;
  `x-defer.off` keeps a route eager. Route panes are held in their own set:
  never in `pending`, never prewarmed, never gesture-promoted — a route
  renders only on activation (the idle scheduler's timing is untouched).
  Nested closed containers register when the route renders, inside the
  gesture window, so they are urgent like any pane the user just opened.
- *Nested routes.* The router's visibility pass is now a worklist: a render
  can reveal nested `[x-route]` elements and they get the same pass in the
  same tick (matching child eager, siblings stashed + hidden). `x-route="!*"`
  also counts routes stashed inside a deferred pane
  (`[x-route] > template[data-mnfst-defer]`) as defined, so the 404 pane
  does not flash for a path that is only defined inside an inactive parent.
- `ManifestDefer.stats().routes` = `{ enabled, stashed, rendered }`.

**Behaviour change with the flag on (document plainly in the guide):**
1. An inactive page's descendants do not initialise at boot: `x-init`,
   `x-data` init(), `$x.<source>` reads, `$computed`, `x-for` inside it all
   run when the page is first shown. The route element's OWN directives
   (`x-data`, `:class`, `x-cloak`) still run at boot. Apps that relied on a
   hidden page's `x-init` to warm a source at boot must read it from
   somewhere eager (the shell, `manifest.json`, or `x-defer.off` on that
   route).
2. `$refs` / `document.getElementById` / `x-dropdown="id"` targets that live
   inside another page resolve only after that page has been activated once.
3. Component-based routes (`<x-page x-route="…">`) are unaffected: the
   components plugin already loads them per route and REVERTS them on leave
   (no keep-alive) — this spike only changes inline `[x-route]` subtrees.
4. `data-order` / `$edit` and anything that walks a page's DOM at boot sees a
   `<template data-mnfst-defer>` instead of the page until activation.

**Numbers** (headless Chrome via `scripts/perf/probe.mjs`, new `boot` and
`route-activate` scenarios, medians of 3, this repo's `/perf?routes=20` = 20
inactive inline pages × (3 closed 40-row menus + a 100-row list) on top of
the standard harness):

| `/perf?routes=20` | flag off | flag on |
|---|---|---|
| boot blocked (long tasks to ready) | 2,000ms | 1,366ms (−32%) |
| longest boot task | 374ms | 170ms |
| ready at | 2,423ms | 2,032ms |
| pages initialised at boot | 20 | 0 |
| x-defer pending / routes stashed | 72 / 0 | 3 / 27 |
| route-activate: reveal after click | 9ms | 10ms |
| route-activate: rows visible at unhide | 100 | 100 |
| route-activate: blocked / mutations | 0 / 4 | 0 / 213 |
| menu-open input latency | 83ms | 81ms |

The 27 stashed = 20 harness pages + 7 of the test project's own inline
routes. The other boot work (feed landing, getter grid) is unchanged, which
is why the floor is ~1.3s here. Activation cost is the page's own cold
render (213 mutations, under the long-task threshold for this page size);
the page is visible with its content in the same frame as before.

`/perf?source=x` (no harness pages — only the test project's own 7 inline
routes are inactive; pre-spike master = `git archive 147b70b` served from a
scratch folder, same probe, same machine, runs back to back):

| `/perf?source=x` | master (147b70b) | branch, flag off | branch, flag on |
|---|---|---|---|
| boot blocked | 2,946ms | 3,170ms | 887ms |
| longest boot task | 1,975ms | 1,991ms | 226ms |
| ready at | 3,763ms | 3,776ms | 1,503ms |
| x-defer pending / routes stashed | 13 / 0 | 11 / 0 | 2 / 7 |
| first-open / warm-switch mutations | 110 / 69 | 110 / 69 | 110 / 69 |
| menu-open input latency | 82ms | 81ms | 82ms |
| local-write mutations | 2 | 2 | 2 |

Flag off is at parity with master (ready within 13ms, same longest task;
the blocked delta is run noise on a 2s task). Flag on removes the ~2s boot
task, which in this project is the inactive editor (`x-route="/"`), chat and
text-edit demo pages initialising for a `/perf` visit — the exact shape
Playcom's platform page has.

**Recommendation: do not make it default yet — soak it on Playcom first.**
The win is real (209 of Playcom's 446 deferred containers, and every other
binding on those pages, sit under inactive routes) and the mechanism is the
same one closed menus already use, but the behaviour change is semantic,
not just timing: a hidden page's `x-init`/`$x` reads move from boot to first
show, and cross-page id/ref lookups move to after activation. Soak plan:
Playcom's A/B branch with `data-defer-routes` on the loader, their operator
walks every top-level route once (each first activation must paint complete
— reveal ≤ one frame, no blank pane, no `[Manifest]` console errors), then
the boot / idle-3s / cold-switch table from §10.8 with `stats().routes`
captured at boot. Risks to watch there: pages whose boot-time `x-init`
seeded shared state read elsewhere; `x-anchors` scopes on a deferred page
(refresh runs after the render via its MutationObserver, but the 800ms
fallback caps it); `$edit`/head processing that walks inactive pages; and
View Transitions capturing a pane mid-render (the render is synchronous
inside the transition callback, so it should not). Default-on can follow
one clean soak plus the guide section from §11.4; the kill switch and
`x-defer.off` per route stay as the escape hatches.

### 10.10 RC.4 — `mnfst@0.5.198-next.4` (2026-09-02)

RC.3 + idle-only prewarm (77f7eb6), P5 (f3021c9), the `bindings` x-text guard
(1db351e), probe/cdn-warm tooling (ec5e9ce), and the route-level deferral
spike behind `data-defer-routes` (bc82fa7, OFF by default — not part of the
A/B). Verified on the registry and both CDNs; payloads checked for the
timeout-free scheduler, the route flag, `bindings` in the loader defaults and
`$stale` in the data plugin. Promotion gate unchanged: Playcom's event-only
table at RC.2/RC.0 boot and idle levels, countries open ≤250ms by toggle
events, no regressions → `npm run release` (0.5.198).

### 11.6 Operator memoization — `$search` / `$query` / `$route` cached per source version (2026-09-02)

**Status: SHIPPED to master (merge a539754, 2026-09-02)** — 15 tests in
`tests/data-operators-memo.test.js`; only source change is
`data/shared/proxies/creation/manifest.data.proxies.array.js`.

Andrew's question ("if computing is always useful for filters and searches, is it
not worth baking into `$x`?") — answer: yes for the operators the framework owns.
User derivations stay on `x-computed` / `$computed`.

- Cache: `WeakMap<rawArray, { v, map }>`, namespace `Alpine.raw(array)` (proxy and
  raw share one entry; chained results get their own). Key
  `${_v[source]}|${op}|${stableStringify(args)}`; insertion-ordered `Map` as an
  8-entry LRU; a version change replaces the whole map.
- `stableStringify`: sorted keys, arrays, primitives, bigint, Date; returns
  `undefined` (→ uncached call) for functions, symbols, class instances, Map/Set,
  depth > 8. `$query` with `orderRandom` never memoized. Arrays with no
  `_v[source]` (not a `$x` source) uncached. Appwrite `$query` untouched.
- Subscription: callers subscribe to `_v[source]` only (the same dependency
  `magic.core` `track()` registers); the compute runs in a released throwaway
  effect, so consumers no longer subscribe to every row field the filter read.
- Probe (`?source=x&search=1`, 51 per-row `$search` bindings over 1,000 rows):
  first-open blocked 59 → 0 ms, warm-switch 54 → 0 ms, mutations identical.
  Suite 433/433 after merge.

**Deviation (law):** an in-place row write that bypasses the mutation API
(`row.name = 'x'` on a `$x` row) does not bump `_v`, so `$search`/`$query`
consumers do not re-run until the next landing/version bump. Every framework
path (landings, `updateEntryInStore`, `$register`, team/locale) bumps `_v`, so
this matches the P6 contract; document as "use the mutation API for writes you
want operators to see".


### 10.11 RC.4 passes Playcom's gate (2026-09-02) → promote to 0.5.198

B = perf-base-sep2 + 0.5.198-next.4 (A/B branch 50ed38f0), route deferral
OFF, priority="1" on both real countries menus, pane DISPLAYED, events +
observers only, load 4.4–5.0 (worst of any row).

| Row | RC.4 | Reference |
|---|---|---|
| Boot (+22s) | 34 tasks / **3,336ms** / longest 147ms; /v1/account 2 | RC.2 quiet 32 / 4,589 / 274; RC.3 7.0–8.0s |
| Idle 3s (+25s) | **0ms** blocked / 414 mutations / 0 fetches | RC.0 0 / 959 (x-text guard) |
| Cold switch #1 (8s) | 3,960ms / **4,994** mutations / 14 fetches | RC.2 3,961 / 10,952 / 18 |
| Countries, +500ms after mount | rows on screen 201ms; toggle:open 327ms (395ms longtask — cold render of the plain 243-row list while the pane finishes mounting) | ceiling 250 |
| Countries, +1,336ms after mount | rows 83ms; toggle:open 83ms | — |

stats(): warm capped at 48, armed at both clicks, bootDrained. No functional
regressions in what was driven (switches, contact panel, kebab, picker search
and tick). The single miss is the plain list's cold render, which the
candidate tree's x-virtual picker addresses (P4 posture). **Verdict: promote
via `npm run release` → 0.5.198; Playcom staging then takes `latest`.**
Post-release: docs session from the brief; route-deferral soak on their A/B
branch when they choose; the `$id`-less-rows and API-URL-reload follow-ups
stay open.

Candidate row (staging tip ea56b364 + next.4, x-virtual pickers, priority="1",
load 6–8 — a floor, not a best case): boot **27 tasks / 3,048ms / longest
178ms** (lowest of the whole effort); idle 3s 0ms / 276 mutations; cold
switch #1 4,643ms (load-inflated) / 4,438 mutations; countries (16 windowed
rows of 243, cold both times): toggle:open 147ms at +362ms after mount
(288ms longtask = the pane's own mount overlapping) and **46ms** at +1,196ms
with **0ms longtask**; search and tick work. The ≤250ms criterion is met on
the tree that ships, with no warm container needed. Green from Playcom.

### 10.12 Released — `mnfst@0.5.198` on `latest` (2026-09-02)

Promoted with `npm run release` after Playcom's RC.4 pass. Verified: npm
`latest=0.5.198`; exact-version files on both CDNs; `@latest` payload checked.

**Incident at release:** jsDelivr caches the `@latest` alias for up to 12
hours (`s-maxage=43200`) and our pull-through Worker proxied aliases from it,
so for ~4 minutes after publish the default loader path served the 0.5.197
loader and plugins. Immediate fix: purged jsDelivr's alias for all 144
shipped files. Structural fix, deployed (manifest-cdn `becd5fa3`): the Worker
resolves dist-tags (`latest`, `next`, bare package) from
`registry.npmjs.org/<pkg>/<tag>` with a 60s edge cache and serves the exact
version from its immutable store under a 60s TTL — a release is live on the
default path within a minute, independent of any third-party alias cache.
Ranges keep the old proxy path. Note for Playcom-style deploys: an explicit
`mnfst@x.y.z` pin remains the reproducible choice for content-hashed gates.

### 10.13 RC `0.5.199-next.0` blocker — loader hang on a pre-existing plugin tag (2026-09-02)

Playcom's staging (and local) never booted on the RC: all plugin scripts loaded,
`__manifestLoaded` never set, no Alpine, blank page, zero errors. Root cause is a
latent loader bug, byte-identical in 0.5.198: `injectScript` found an existing
`<script src=…>` for the plugin and tested `existing.complete` (an image
property; always undefined on scripts), then listened for `load` on a tag that
had already fired → the plugin promise never settled → `Promise.all` never
resolved. Trigger: pinning the loader (`data-version`) to the same exact
version as an author's explicit plugin tag makes the loader's first candidate
URL match that tag (with `@latest` on the loader the URLs differed, so 0.5.198
never hit it). Fix (master, `fix(loader): never hang…`): an existing tag resolves
at once when it has already run — loader-injected tags are marked
`data-mnfst-loaded` on load; a parser-inserted classic tag ahead of the loader
has executed; a resource-timing entry exists; or the document is complete —
plus a 50ms poll and a 4s bounded fallback so boot can never block on it.
Tests: `tests/loader-inject.test.js` (3; fails on the old loader) + real-Chrome
proof (old: Alpine undefined, blank; new: boots, one tag). → RC.1 required.

## 12. Persistence brief (Playcom, 2026-09-02) — PENDING Andrew's scoping, nothing built

Three primitives for instant boot: (1) app-shell service worker — Manifest
ships none today; opt-in, generated at publish, keyed by the deployment hash,
activate on next navigation; (2) persisted `$x` — extends P5: per-source
IndexedDB snapshot written on landing (debounced), hydrated BEFORE the network
with `fresh: false`, reconciled by the identity-preserving upsert; per-source
opt-in (`persist: true | { ttl, maxRows }`), store keyed by project + source +
scope key, `$x.$wipe()`, row-level field filter, caps + quota tolerance;
(3) persisted `$chat` windows on the same store. Measured: a normal reload is
already shell-cache-hot (153/198 resources from HTTP cache, ~15 KB, load
344ms); the ~10s was the hard-refresh path → order = 2, then 1, then 3.
Acceptance: warm first useful paint from disk <500ms; shell requests 0 (SW);
boot blocked time unchanged (~3s) or better; logout empties the scope; no
cross-workspace row ever renders; zero new server calls.

### 12.1 Playcom's primitive-2 input (field NAMES only, no values)
Scope key = `workspaceId` for every source; wipe on logout, workspace switch,
and any `manifest:auth:*` session-cleared.
- **Tier 1 (hydrate before first paint):** `chats` 500 most recent by
  lastMessageAt, strip `lastInboundPreview`; `contacts` 2,000, strip `name,
  email, phone, country, countries, ip, personalId, contactSourceId,
  customFields` (wire row already null there; their grant-gated PII sidecar is
  memory-only and must never persist); `contactChannelIdentities` 2,000, strip
  `handle, platformUserId`; `channels, userAliases, spaces, tags, tagGroups,
  statuses, priorities, caseTypes, selectOptions, customFieldDefs,
  recordTypes` all rows, no strip; `teams, teamMemberships, memberProfiles`
  all, strip `memberProfiles.email`; `workspaceSettings` 1 row, strip names
  matching `credentials*` / `*Secret*`.
- **Tier 2 (hydrate on first use):** `threadNotes` 500 strip `text`; `cases`
  500 strip `description`; `chatReplies, emailTemplates, quickActions,
  procedures, savedViews, savedFilters, dashboardViews, aiAgents, tools,
  knowledgeBases, knowledgeResources` all, no strip.
- **Never persist:** audit, bans/banRules/banReasons, consentCommsState,
  copilotSessions, csatFeedback, aiAnalysisResults, promotions/promotionRules,
  proactiveEngagements, modelCredentials, agentConnectors, emailDomains,
  emailAddresses, billing.
- Static bundled catalogues: unscoped, persist optional (already HTTP-cached).
- **Primitive 3:** key `workspaceId + chat DO id`; last 50 messages for the 30
  most recently opened chats; no strip (bodies are PII by nature — scope, wipe
  and caps carry it); dedupe by message id + `meta.externalId`.
- Realtime-subscribed tables (reconcile source of truth after hydration):
  chats, contacts, channels, chatReplies, contactChannelIdentities, aiAgents.

Design implications to settle in the RFC before building: a "hydrate tier"
(before-first-paint vs first-use) per source; the strip filter as a manifest
option (names/patterns) with a runtime hook for computed cases; wipe wired to
the auth plugin's events by default; caps enforced at write time with LRU by
recency field; hydration must never delay a cold boot (IDB miss → network as
today).

## 13. App-shell service worker — turnkey, fail-open, zero infrastructure (accepted 2026-09-02)

**Principle:** automatically used when it can help, silently ignored when it
cannot, never in the way. No configuration; one kill switch. If anything about
it breaks or goes away, projects load exactly as they do today.

### 13.1 Why it is not "infrastructure"
A service worker is client code, served like a plugin. The only hard
constraint is the browser's: the registered script must live on the
project's own origin. So the design is a two-line same-origin **stub**
(`/sw.js`) that `importScripts()` the real worker from the CDN at the same
pinned version the loader uses. All logic ships and versions with the
framework; nothing runs on our servers; CDN bandwidth goes DOWN (cached
assets). Cost model for an open-source framework at millions of end users:
build ≈ one plugin plus one hosting tweak plus docs; upkeep ≈ browser drift
fixes; infrastructure ≈ 0. Provided as-is.

### 13.2 Turnkey inference (no config)
The loader registers the worker only when ALL hold:
1. not a dev/local origin (`localhost`, `127.0.0.1`, `*.local`, `mnfst-run`
   in play) — dev never fights a cache;
2. `https:` (or the browser otherwise allows SW);
3. the kill switch is off (`manifest.json` `"sw": false`, or `data-sw="off"`
   on the loader script; also honoured by an already-installed worker, which
   unregisters itself);
4. a same-origin `/sw.js` stub answers with JavaScript (HEAD/GET probe, cached
   per session). No stub → nothing happens, no error, no console noise.
Where the stub comes from, in order of how turnkey it is: **Manifest managed
hosting serves it implicitly** for every hosted site (the host Worker
answers `/sw.js` with the stub pinned to the site's framework version —
signed-up users get it without knowing it exists); `mnfst-publish`/render
emit it for self-hosted output; the starter template ships it; anyone can
add the two lines by hand.

### 13.3 Caching rules (what keeps "publish and it's live" true)
- Documents (`/`, `*.html`, route navigations) and `manifest.json`: **network
  first**, cache fallback only when offline. A publish is visible on the next
  navigation, always.
- Content-addressed assets (`?v=<deployment hash>`, `mnfst@x.y.z/…`,
  Alpine/Iconify pinned URLs): **cache first, immutable**; the stamp is the
  invalidation.
- Everything else same-origin (unstamped images, fonts, data files):
  stale-while-revalidate with an LRU cap.
- Cross-origin API/data (Appwrite, workers, analytics): never intercepted.
- Optional precise precache: publish/render can emit `/precache.json`
  (the deployment's file list + hash); when present the worker warms it in
  the background after activation, giving instant offline for hosted apps.
- Update: new worker installs in the background, activates on the next
  navigation; never swaps a live tab's assets underneath it. Old caches are
  keyed by framework version + deployment hash and pruned on activate.

### 13.4 Fail-open guarantees
Registration failure → no worker (site loads normally). `importScripts`
failure (CDN unreachable, bad version) → install fails → browser keeps the
previous worker or none. Any fetch-handler exception → `fetch(request)`
pass-through. Activation self-check: if the framework module did not load,
`self.registration.unregister()`. Kill switch honoured on every navigation.
Local dev: `mnfst-run` serves `/sw.js` as an unregistering no-op so a stale
worker from a previous deploy can never hold a dev session hostage.

### 13.5 What it unlocks beyond warm boot
Web push (`$push` web fallback needs a worker), offline-capable PWAs (iOS
requires a worker for offline), navigation preload / app-shell instant paint,
and the bytecode cache for scripts served from CacheStorage. Designed once
for all four; the worker exposes a small message API so push and offline
land as extensions, not rewrites.

### 13.6 Build plan
`src/scripts/manifest.sw.js` (worker logic, standalone script — no Alpine,
no DOM) + loader registration/inference/kill switch + `mnfst-run` no-op stub +
tests (a fake `ServiceWorkerGlobalScope` harness for the caching rules;
puppeteer for registration and warm-boot request counts on the src project
served over a local https or via `--host` flag if needed) → then Manifest-MCP
host Worker `/sw.js` stub + publish `precache.json`. Acceptance (Playcom
rig): warm hard refresh shell requests 0, first useful paint from shell
cache, boot blocked time unchanged; cold boot unchanged; kill switch
verified end to end (worker gone on next navigation).

### 13.7 Status — SHIPPED to master (merge d9f429f, 2026-09-02)

`src/scripts/manifest.sw.js` (worker module, version-stamped into
`lib/manifest.sw.js`), loader inference + `Manifest.swStub(version)` +
`Manifest.sw = { registered, version, kill() }`, `data-sw` attr,
`manifest.json` `sw: false` kill switch, `mnfst-run` no-op `/sw.js` +
`window.__mnfstRun` dev marker. Tests: 58 worker (fake scope) + 28 loader
(happy-dom) + 23 real-Chrome e2e (`npm run test:e2e:sw`). Suite 418/418 at merge.

Stub served by hosting (exact text, `text/javascript`, `no-cache`):
```
try { importScripts('https://cdn.manifestx.dev/npm/mnfst@<ver>/lib/manifest.sw.min.js'); } catch (e) { importScripts('https://cdn.jsdelivr.net/npm/mnfst@<ver>/lib/manifest.sw.min.js'); }
if (!self.__mnfstSw) self.addEventListener('activate', function () { self.registration.unregister(); });
```
Registration `/sw.js?v=<data-version|latest>&d=<deployment>`, scope `/`, no
`skipWaiting`/`claim` (first visit never controlled; warm from the second
navigation). Caches `mnfst-sw:<ver>:<deployment|->:{assets,swr,pages}` +
`mnfst-sw:meta`; pruned on activate. Message API `{type:'manifest:sw',
action:'ping'|'version'|'kill'}`.

Matcher deviations from §13.3: tag/range-pinned CDN URLs (`mnfst@latest`,
`d3-array@3`) are SWR not immutable (a `latest` loader would otherwise freeze
until the next publish); `t=<digits>` busters dropped from cache keys
(utilities refetches every stylesheet with `?t=` per compile); cross-origin
refetched `mode:cors, credentials:omit`, opaque never cached; `precache.json`
skipped entirely on deployment mismatch.

Numbers (real Chrome, src project, `data-sw="on"`): stamped assets warm load
70 server hits with **shell 0** (only `index.html`, `manifest.json`, unstamped
data SWR revalidations), 179/185 responses from the worker; with
`precache.json` the second load is already warm (72 hits, shell 1).
**Hard reload bypasses the worker in Chrome by design** — §13.6's "hard
refresh shell 0" is unreachable; the win is normal reloads and navigations.

Hosting/publish: SHIPPED to Manifest-MCP main (7a7ab49, 2026-09-02; 223/223,
not yet deployed). `GET|HEAD /sw.js` (query ignored) → the exact stub, `text/javascript`,
`no-cache`, unless the deployment ships its own `sw.js`; version stored per
deployment (`site_deployments.mnfst_version`, migration `0015`; pin precedence
exact `src` > exact `data-version` > `data-version` tag > `src` tag; dist-tags
resolved via the npm registry at publish); pre-existing rows backfilled lazily
from the stored `index.html` on first `/sw.js`; no pin → `''` → permanent 404;
promote copies the version. `precache.json` built server-side at upload for
connector and CLI paths (index, manifest, CDN scripts, css/js, components
`?v=`, fonts, page HTML, data ≤1 MB; cap 500; always overwrites a site-shipped
one). HTML / `manifest.json` / `precache.json` `no-cache` to the client (edge
keeps its 60s TTL); `?v=` immutable already. cdn Worker needs no change
(`manifest.sw.min.js` → jsDelivr auto-minify → `.js` fallback, JS type forced).
**Deploy order: `corepack pnpm run db:migrate:remote` → `deploy` → `deploy:host`**
(un-migrated DB + new MCP Worker breaks publish/promote); after 0.5.199 warm
`cdn.manifestx.dev/npm/mnfst@0.5.199/lib/manifest.sw.min.js` once.


## 14. Surface restructure (2026-09-02) — behaviours vs plugins

Andrew's rule: plugins are feature-level capabilities an author invokes
(directive or magic, visible output); the core is just the loader. Applied:
- **`defer` and `bindings` are ALWAYS-ON behaviours**, not plugins: the
  loader includes them unconditionally on both the derive and the explicit
  `data-plugins` paths; they are not in the plugin list and cannot be omitted;
  the only knobs are the kill switches (`data-defer="off"`). Docs describe the
  behaviours, never the files.
- **`computed` stays a plugin** (auto-included like every plugin; works alone
  or with anything — it is not `$x`-specific). Primary form is the directive
  `x-computed:name="expression"` (a named cached value from a plain
  expression on the nearest scope — no function, no `this`, no return);
  `$computed(s => …)` for JS factories (the scope is `this` AND the first
  argument; the `function () { this }` form still works).
- `x-virtual` unchanged. The "performance plugins" category disappears from
  the docs: what remains user-facing is `x-computed` and `x-virtual`.
Verified on a page with an explicit `data-plugins="toasts,computed"` list:
only five scripts load (loader, defer, bindings, toasts, computed); a closed
menu is deferred then prewarmed; `x-computed:hits` renders and recomputes.

### 12.2 Persisted `$x` — contract (accepted 2026-09-02; ships with the perf release)

Extends P5. Off by default; nothing changes for a project that does not opt in.

**manifest.json, per source** (inside the source's data config):
```json
"chats": { "url": "...", "persist": true }
"contacts": { "url": "...", "persist": { "tier": "boot", "maxRows": 2000, "recent": "lastMessageAt", "ttl": "7d", "strip": ["name", "email", "phone", "customFields", "credentials*"] } }
```
- `persist: true` = `{ tier: "boot" }` with defaults: `maxRows` 1000, `ttl` 7d,
  `recent` = `$updatedAt` if present else insertion order, `strip` = [].
- `tier`: `"boot"` hydrates before the first paint (during data-plugin init,
  before the first network load of that source); `"lazy"` hydrates on the
  first `$x.<source>` read. Both land with `fresh: false` → `$stale` is true
  until the first network landing reconciles (replace by `$id`: rows absent
  from the fresh landing are removed — reconcile replaces, never adds).
- `strip`: field names or glob patterns removed from every row before it is
  written; built-in always-on patterns `*secret*`, `*token*`, `*password*`,
  `credentials*` (case-insensitive). Runtime hook for computed cases:
  `ManifestData.persistFilter(source, (row) => row | null)` (return null to
  skip the row).
- `maxRows` enforced at write time, keeping the most recent by `recent`.
- Object sources persist whole (after strip). `$id`-less array sources persist
  but reconcile by replacement.

**Scope** (top-level `manifest.json`):
```json
"persistence": { "scope": "$auth.currentTeam?.$id" }
```
An expression evaluated with the magics available; re-evaluated on every
`manifest:auth:*` event. Store keys are `${scope}|${source}`. When the scope
value changes: the previous scope's entries are wiped, memory rows for
persisted sources are cleared, and hydration reruns for the new scope — no
row from a previous scope is ever rendered. No `scope` configured → a single
scope `""` (single-tenant), still wiped on logout / session-cleared.

**Wipe API:** `$x.$wipe()` (current scope, all persisted sources),
`$x.$wipe(source)`, `$x.$wipe({ all: true })` (every scope). Automatic on
`manifest:auth:logout` and `manifest:auth:session-cleared`.

**Store:** IndexedDB database `manifest:${origin}` (plus the project id from
manifest.json when present), one object store `sources`, records
`{ key, scope, source, rows, savedAt, frameworkVersion, deployment }`.
Writes are debounced (500ms after the last landing of that source), never on
local optimistic writes alone (the next landing carries them). Quota or
IndexedDB errors disable persistence for the session silently — never a
thrown error, never a blocked load. Expired (`ttl`) entries are ignored and
deleted. A `frameworkVersion` major/minor mismatch is ignored (not migrated).

**Cold boot never waits:** hydration races the network; a hydration that
arrives after a fresh landing is discarded. Request dedupe (P5) guarantees
one network request per source regardless.

**Diagnostics:** `ManifestData.persistence()` → `{ enabled, scope, sources:
[{ source, tier, rows, savedAt, stale }] }`.

**P5 follow-ups folded in:** API-URL sources must honour the reload contract
(failed reload keeps rows, sets `$error`, never lands the default value over
live rows); `$id`-less rows on reload documented as replacement.

**Primitive 3 (chat windows) contract, built after this on the same store:**
`chat` config `persist: { messages: 50, conversations: 30 }`; key
`${scope}|chat|${conversationId}`; hydrate on `$chat.open()` before the
adapter load, reconcile by message id and `meta.externalId`; same scope,
wipe, ttl and strip rules.

**Acceptance (Playcom rig):** warm reload first useful paint of the inbox
list from disk < 500ms; boot blocked time unchanged (~3s) or better; cold
boot unchanged; logout → the scope's IndexedDB entries empty (assert);
workspace switch → no previous-workspace row rendered at any point (assert
by observing the list during the switch); zero additional server calls.

### 12.3 Playcom's contract inputs (2026-09-02)
- `persistence.scope = "$auth.currentTeam?.$id"` (workspace = Appwrite Team;
  changes on viewTeam() and login, both fire `manifest:auth:*` — covered by
  the re-evaluate rule).
- Tiers/strip exactly as §12.1 (Tier 1 → `boot`, Tier 2 → `lazy`);
  `recent: "lastMessageAt"` for chats, `$createdAt` elsewhere; no
  `persistFilter` needed unless a computed field appears.
- `chat.persist { messages: 50, conversations: 30 }` agreed.
- Their normal-reload finding (theirs): `index.html` loads 93 classic scripts
  through a `document.write` loop — 134 serialized, parser-blocking requests
  from 281ms to 10.4s with 0 long tasks; domInteractive 8.9s. Fix on their
  side: publish-time concatenation into one classic file (expected ~8s → <1s).
  One CDN sample of an aborted `manifest.components.min.js` fetch (8.2s,
  status 0) is attributed to that queue; re-check after their concat.

**§12.2 status: SHIPPED to master (merge 3e46256, 2026-09-02)** — 32 tests
(330→332 with the merge), `core/manifest.data.persist.js`, in-memory IDB
double for tests, `scripts/perf/persist.mjs`. Harness: warm first row 407ms
from disk (`$stale` true) vs 1,316ms cold; one request per source cold and
warm; logout → 0 keys; scope switch: list emptied at 46ms, 0/41 samples show
a foreign row. Deviations, accepted: records carry `locale`; framework
version stamped at build (`MANIFEST_BUILD_VERSION`), mismatches deleted;
scope tracked reactively as well as on auth events (team switches fire no
event); boot hydration awaited inside init with a 100ms cap; writes on any
network landing (not only fresh); `maxRows` without a recency field keeps
insertion order; API-URL failed FIRST load lands the default with `$error`
+ `$stale` (failed RELOADS keep rows); `$wipe` is IDB-only (memory cleared
on scope change); `window.ManifestData` created for the hooks. Store API
for primitive 3: `ManifestDataPersist.records` (`enable/enabled/scope/key/
get/put/delete/keys/clear/valid/ttl/stamp`) + `manifest:persist:scope`.

### 12.4 Primitive 3 — persisted chat windows: SHIPPED to master (merge dd25319, 2026-09-02)

22 tests in `tests/chat-persist.test.js`; suite 455/455 after merge. New
`src/scripts/chat/manifest.chat.persist.js` (`window.ManifestChatPersist`),
store/main edits, `data.persist.js` `state.external` (a prior
`records.enable()` survives the data plugin's later `configure()`).

Config: `"chat": { "persist": true | { "messages": 50, "conversations": 30,
"ttl": "7d", "strip": [...] } }` (also under `ai`). Off by default; needs the
data plugin. Records on the same DB/object store as `$x`: conversation
`${scope}|chat|${id}` → `{ kind:'chat', rows:[last N non-optimistic
messages], … }`; index `${scope}|chat` → `{ kind:'chat-index', recent:[ids]
}` most-recently-opened first, capped at `conversations`, overflow records
deleted immediately. Strip = always-on secrets + configured names/globs/dotted
paths + every `_*` key + functions. 500ms debounce per conversation, all due
conversations + index in one `records.put` transaction.

Open/hydrate/reconcile: `$chat.open(id)` starts hydrate and the adapter load
together (never awaits hydration); record-first → rows flagged `_hydrated`,
`$chat.stale` true, status stays `loading`; adapter lands → reconcile (absent
by id or `meta.externalId` dropped, fresh rows upsert onto existing rows
keeping identity, optimistic sends while stale survive); late hydration
discarded; failed load keeps the window (stale, `status='error'`). Scope
change / logout / session-cleared → generation bump, pending writes
cancelled, every handle `reset()` to empty+idle. `$chat.persistence()` →
`{ enabled, conversations:[{ id, messages, savedAt, stale }] }`.

Numbers (`scripts/perf/chat-persist.mjs`, netMs 400): warm reload first row
**366ms stale** (cold 1109ms); in-page warm open first row **16ms** (cold
414ms); eviction 31 → 30 records, evicted exactly the least-recently-opened;
scope switch 0 foreign samples, window empty at 10ms.

Playcom review (718015f): `meta.externalId` is a platform id unique only within
a channel, so the secondary identity is `(meta.channel, externalId)` when
`channel` is present; a channel-scoped lookup still upgrades a channel-less
row with the same externalId; a channel-less incoming never matches a channel
row.

Playcom gate findings on next.0 (2026-09-02): (1) their pane opens a first
handle then swaps to a composed-adapter handle for the same id; hydration was
per handle and asynchronous, so the second handle's instant load beat the
IndexedDB read every time and the disk window never rendered. Fix: the last
known window per conversation (disk read or written snapshot) is kept in
memory for the generation (`ManifestChatPersist.peek`) and any re-open
hydrates from it synchronously before the adapter load starts; a first open
still races (never awaits). (2) Ephemeral ids (`copilot-_new:0-<ts>`, 0
messages) took index slots at open(): a slot is now earned on the first
non-empty write; an evicted conversation re-enters on its next message
(activity is recency); `$chat.open(id, { persistWindow: false })` opts a handle out
entirely (namespaced: the open() bag is the adapter's contract, Playcom's
adapter already read `opts.persist`). Tests 26 (was 22).

Deviations: `meta.externalId` is now a general secondary identity in the
store's `upsert` (applies to realtime too); after a scope change handles go
idle rather than re-opening (re-opening old ids under a new scope could
render another workspace's messages) — the app re-opens as it navigates;
aggregate handles not persisted (`$chat.merge` reports `stale` from members);
`ManifestDataPersist.configure()` returns `true` only when a `$x` source opted
in.

### 12.5 Gate findings on next.0/next.1 → fixes in 4a9e1aa (2026-09-02)

- **Boot double read (law):** with a scope expression configured and the auth
  plugin still booting, an empty scope is *pending*: no keys, no wipes, no
  resets. When identity/teams resolve, rows loaded meanwhile stay and are
  written under the real scope; only sources that have not landed hydrate from
  disk. A real A→B switch still resets. Settles on `manifest:auth:teams-loaded`,
  on `initialized` when unauthenticated or teams are off, on logout /
  session-cleared, or after 10s. Before: "" → team id at boot was treated as a
  switch → every persisted source reset + reloaded (18 redundant Appwrite reads
  per reload on Playcom) and the "" scope wiped.
- **Team prefs storm:** `getUserGeneratedRoles` (team prefs) is cached per team
  for 15s and shared by concurrent permission checks (null cached too);
  dropped on any `manifest:auth:*` event or a prefs write (8 call sites). Was
  one `teams.getPrefs` per check: 14 per boot from framework frames.
- **Playcom's numbers (next.1, hidden pane, event-based rows):** persisted
  reload domInteractive 278ms, inbox rows from disk 765ms, shell 69/69 from
  the worker; SW-off run: blocked time identical (4.9s vs 4.5–5.4s) → the
  blocked tail is their data plane + render (118 API calls, 106 Appwrite; two
  app lanes running), not worker scheduling. Their "defer never arms" report
  was a hidden-pane artifact (retracted); headless matrix on next.1 arms in
  every variant. Open: "rows from disk at 6.4s when the worker is not
  controlling" — hidden-pane run, unverified.
- Tests: 33 persistence (+1), 3 roles-cache (new). Suite 466/466.
- **Chat upsert merges `meta` (was replace):** a re-delivery of a message from
  a second source (echo without `tx`, or without `channel`) replaced `meta`
  wholesale, so translation fields could flap as sources alternated (Playcom:
  one translated bubble flickering at random). Every `commit()` still creates
  fresh top-level and `body` objects by design; `meta` identity is now stable
  across commits and merges.
- **One manifest.json request per boot (cace566):** Playcom's cold reload
  fetched it 4× (loader, data plugin, auth plugin, components registry with a
  `?t=` buster; a 4th at ~5s from the status plugin refetching whenever the
  loaded manifest had no `status` block), three in parallel on the critical
  path (~0.5s). The loader now publishes its in-flight fetch as
  `window.__manifestPromise` the moment it starts; data, auth, components,
  payments, status and `swInfer` await it (interpolated) instead of fetching;
  without a loader the first plugin to fetch shares it. Tests:
  `tests/manifest-shared-fetch.test.js` (2). Suite 468/468.
- **RC.3 gate (Playcom, visible pane, loop fixed):** warm reload domInteractive
  432/231ms, inbox rows from disk 731/535ms, shell 178/171 from the worker + 0
  network, framework-frame prefs 1, API calls per reload 118 → 26/33, last API
  response 9–11s → 1.6/1.3s, idle 1 flush/s (their clock), the 250/s loop gone.
  Two rows failed → fixed in 2cfd09b: (a) the boot scope transition still
  dispatched `manifest:persist:scope`, and the chat plugin reset every window
  (their composed handle never showed its disk window) — the event now carries
  `boot: true`; chat keeps handles, hydrates the still-loading ones under the
  real scope (`hydrate` hook on attach) and writes them there; (b) index ids
  with no record (pre earned-slot) are pruned on adoption (read keyed by id,
  not position — a promote can reorder the live array mid-read). Also
  `SLICE_MAX` 8 → 2 for prewarm: one big menu render is already a long task.
  The `?t=` request was Playcom's own helper; the remaining +28ms fetch was the
  localization plugin (`getAvailableLocales` never awaited `__manifestPromise`) →
  fixed b3ed07e; 1 config fetch per boot verified with CDP initiator stacks.
  → RC.4 (with the `device` rename): rows 1–2 PASS on next.4; release tree.  Open: a second `manifest.json?t=` request on their page (components registry
  fallback; initiator requested). → RC.4 (with the `device` rename).

## 15. Next: publish-time utility CSS (proposed 2026-09-02, post-0.5.199)

Playcom (Acme Demo, visible): the utilities JIT patches the runtime stylesheet
85 times over the first 19s (10 style inserts, 3 after the list renders;
`utilitiesReady` 4.2s) — Andrew sees "items reposition after they've loaded".
Shape: the render step already runs the page headless; after prerender, capture
the utilities plugin's generated stylesheet and emit it as static CSS in the
deployed tree (hosting/publish for SPA sites via the same headless pass), and
teach the runtime compiler to treat rules already present as covered so the JIT
only patches classes that appear later (user content, late components).
Acceptance: zero style inserts before first paint on a prerendered page; JIT
patches only for classes absent from the static sheet; `utilitiesReady`
before first paint. Owner/priority: Andrew.

**Framework half SHIPPED (merge 5b862e5, 2026-09-02):** `lib/manifest.utilities.node.mjs`
exports `compileUtilities({ classes, themeCss, baseCss })` and `scanClasses(html)`
(same generator prototypes, no fork); CLI `scripts/utilities-static.mjs <dir>`;
runtime reads a `<link|style data-mnfst-utilities>` once and skips covered
classes in `compile()` and the localStorage replay; render's
`prerender.utilities.css` link carries the attribute. Proof (src docs homepage,
real Chrome, 5s): cold 2 style writes → 0 with a static sheet. Tests +15
(505/505). Not DOM-free: sync.js critical pre-paint path (lower impact).
**Hosting half SHIPPED (Manifest-MCP main 3543e6d, 2026-09-02; 260/260; not deployed):**
publish scans html/md (shares the precache R2 reads), collects theme CSS, compiles
via `mnfst/lib/manifest.utilities.node.mjs` (computed import; no-op until `mnfst`
≥0.5.199 is a dependency), writes `/manifest.utilities.css?v=<deployment>`,
injects `<link data-mnfst-utilities>` before the first stylesheet (idempotent;
skipped when render already emitted a sheet), lists it in precache. Deploy after
0.5.199 + `pnpm add mnfst@^0.5.199`.

**§15 post-release findings (2026-09-02, after 0.5.199):** the node compiler
emits only theme-variable-driven and custom utilities (static `.flex`/`.row`
live in `manifest.min.css`), and 0.5.199's theme-variable regex dropped the
last declaration of a block with no trailing `;` (so a minimal theme produced
nothing). Fixed on master (merge 9430dc4; node shims; node-environment tests)
→ patch release 0.5.200 required. Hosting must feed the CDN-linked
`manifest.min.css` (cross-origin) as `themeCss` at publish or output is empty
(Manifest-MCP `agent/utilities-theme`, in progress). Manifest-MCP main imports
the compiler statically (7240e54; a Worker cannot resolve modules at runtime).

**§15 first live proof (docs staging, 2026-09-02):** publish generated
`/manifest.utilities.css` (14 KB) from the CDN-linked theme and injected
`<link data-mnfst-utilities>`; the 0.5.199 runtime treats it as covered.
Renderer: hard per-page timeout added (60s, `prerender.pageTimeout`) after the
Device docs page hung a render; the page also freezes a live tab (under
investigation). `mnfst-render` on npm is 0.5.38 — stale vs mnfst 0.5.201; run
`release:render`.
