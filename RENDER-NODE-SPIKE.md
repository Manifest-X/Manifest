# Node (browserless) render spike — findings

Branch `spike/node-render`, 2026-10-27. Parked: no-go for now.

## What was built

`src/scripts/manifest.render.happy.mjs`: a Puppeteer-shaped page over happy-dom 20.11.6, switched on with
`MNFST_RENDER_ENGINE=happy`. `renderRouteDom`, finalize, discovery and output run unchanged. Adapter pieces:

- shared response cache across pages, blocking-script prewarm
- render-environment shim: displayed elements measure 1×1 (`getBoundingClientRect`, `checkVisibility`),
  `IntersectionObserver` reports displayed targets once, inert `PerformanceObserver`
- happy-dom workarounds (all upstream bugs): classic scripts not run at global scope (UMD globals lost);
  `:class` gets local name `class` and corrupts the real class attribute; a trailing `//# sourceMappingURL`
  comment breaks the script wrapper; Node's real `PerformanceObserver` pins every closed page (leak);
  page unhandled rejections end the process
- no OG snapshots (no pixels)

## Results

| | Chrome | happy-dom |
|---|---|---|
| Canary (9 pages) parity | — | 8/8 identical |
| manifestx.dev (119 pages) parity | 116/119 vs itself | 8/119 identical |
| manifestx.dev wall | 5m 9s | 8m 49s |
| manifestx.dev CPU (user+sys) | ~295s | ~476s |
| Peak RSS (largest process) | ~660 MB | ~4 GB |

Remaining manifestx.dev gaps: code highlighting partly missing, colour picker internals, charts
("Chart engine failed to load"), one `x-text` span (see engine bug below).

Profile of a warm heavy page: ~31% happy-dom MutationObserver bookkeeping (subtree observe/disconnect walks
the whole tree), 7% GC, 10% Alpine, 8% Manifest. Fixing the observer cost would bring CPU to roughly
Chrome's, not below it.

## Why no-go

- No cost win: happy-dom uses more CPU and memory than Chrome for the same pages.
- Wall time in both engines is dominated by fixed settle windows (~2s/page), not the engine.
- Fidelity: layout/canvas plugins (charts, colour picker) need Chrome anyway; each happy-dom upgrade risks
  new gaps.
- Hosting: can't run in a Worker (no `node:vm`, no code generation); needs Containers plus a per-render
  sandbox (happy-dom is not a security boundary).

## What carries over

- A framework "render complete" signal to replace the fixed settle windows helps Chrome renders directly
  (the largest share of per-page wall time).
- Engine bug found via the diff: the x-for clone walk (`stripLoopBindings` caller, manifest.render.page.mjs
  ~2533) ends a loop's clones only by tag name, so it can overrun into a following same-tag element and
  strip a non-loop binding whose expression mentions the loop variable as an arrow parameter
  (`$x.site.docs.find(d => …)` next to `x-for="d in $x.site.docs"`).
- Revisit if a faster DOM (or happy-dom fixing the observer/leak issues) changes the CPU picture.

Harness: canary + manifestx.dev source, `--no-incremental --no-run-cache`, DOM-parsed canonical comparison
(attributes sorted, ids/style/aria dropped, hydration records filtered to elements present).
