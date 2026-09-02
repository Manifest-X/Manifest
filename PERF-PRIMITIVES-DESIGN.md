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
| 1b | `x-defer` + defer-by-default + prerender parity | Fable | worktree agent |
| 1c | P6 landing model | Fable | worktree agent (manifest.data.js is 11.6k lines — narrow diff) |
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
