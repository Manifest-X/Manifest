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
