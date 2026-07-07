# Native App Support — design RFC

Status: **draft / in progress** (2026-07-06). Working notes for elevating Manifest
from "wrap the PWA" to first-class, store-grade native support (iOS-first, App
Store Guideline 4.2). Not a public doc; for our own review/editing. Motivating
project: **Nurvana** (B2C, MCP client, luxury-goods allocation — physical commerce
leg + web-billed subscriptions), but every decision here is deliberately
**framework-agnostic**, not Nurvana-specific.

## TL;DR

One **agnostic** app codebase — desktop web, mobile web, and mobile native
compatible in form and function (the Playcom model) — **not** an iOS-only shell.
"Native" is an **opt-in packaging + capability layer** that sits beside the normal
build, never a fork of it. The prerender/hydration contract already forces every
plugin to be environment-agnostic, so native features are progressive enhancement
*by construction*.

Four buckets:

| Bucket | What | Weight |
|---|---|---|
| **Primitives** | safe-area/inset + meta layer, web-tell suppression, bottom-tab nav convention, `theme_color` in starter | agnostic; helps mobile web too |
| **`$device` signal** | unified device-state magic (os / touch / online / standalone / native / platform) + matching CSS variants | base in core; enriched by umbrella |
| **Native umbrella plugin** | one opt-in plugin family; capability-first (biometric, push, haptics, share, camera/photos, deep links, lifecycle); **Capacitor is one adapter** | opt-in, no-ops on web |
| **Docs + example** | Capacitor path + App Store readiness + 4.2 checklist + payments boundary; Capacitor wrap as opt-in add-on to the **standard** starter | docs-first, highest leverage |

Store-grade packaging = **Capacitor** (real native project + native plugin
access → 4.2-achievable), documented *alongside* PWABuilder (kept, but honestly
reframed as 4.2-risk for iOS). We **bless the config; the author runs Xcode/CLI** —
Manifest does not own the native build toolchain (no Mac CI commitment).

## Progress (2026-07-06)

- ✅ **Docs** — `native-apps.md` reframed (Capacitor path, honest 4.2), new `app-store-readiness.md` (feel-native, native capability, physical-vs-digital payments, 4.2 checklist) on the website repo `staging` (not yet published; hold production until primitives ship). Privacy-manifest section still to add.
- ✅ **Primitives** — safe-area `--safe-*` + `p/px/py/pt/…-safe` utilities, `min-h-dvh`/`h-dvh`, opt-in web-tell utilities (`no-callout/select/tap-zoom/overscroll`), `viewport-fit=cover` + apple/mobile meta, starter `theme_color`.
- ✅ **`$device`** — base signal in core/utilities (`os/touch/online/standalone/native/platform`), `html[data-online|standalone|native]` + `offline:/online:/standalone:/native:/web:` variants + `*-only` classes, reactive store. `/native` QA harness on the src test page.
- ✅ **Dock** — `[dock]` attribute component (`<nav dock>` best practice; fixed + safe-area *physics* baked in, skin themeable via `--dock-*`: edge-to-edge default, floating via `--dock-inset`/`--dock-radius`; active state via `$route` + `[aria-current]`). Auto-included via elements glob.
- ✅ **Native umbrella** — `manifest.native.js` (opt-in; `native/` subscripts). Core stamps `data-native/data-platform` for `$device`; loader auto-injects on `window.Capacitor` or a manifest `"native"` block. Capabilities landed (web fallbacks verified on `/native`): **`$share`** (native sheet→Web Share→clipboard), **network** (upgrades `$device.online` in-container), **`$secure`** (Keychain/Keystore ↔ namespaced localStorage; `.use()` override), **`$links`** (Capacitor App appUrlOpen/launch URL → router handoff via its click interceptor; `.on()` author override; `.open()` on web).
- ⏭ Next capabilities (proving-ground order): **push** (3 contracts — permission timing, device-token hook, tap→router; couples to `$links`+lifecycle) → **biometric** → **haptics**/**camera**/**lifecycle**. Then Capacitor wrap → payments adapter. TODO: `"native"` block in `manifest.schema.json`; per-capability + `$device` docs pages.

## Ethos / constraints (unchanged)

- Core stays minimal; native features are **opt-in plugins**, not core weight.
- **Progressive enhancement**: every native capability degrades cleanly to web.
- Alpine-idiomatic, HTML-first APIs consistent with existing plugins; terse
  plugin comments (gold refs: `manifest.toasts.js`, `manifest.tabs.js`).
- Must not break Manifest's use as an **MCP client** (the client is just JS/network
  in a WKWebView — native secure storage is a *plus*, not a risk).
- Dogfood where practical; MIT throughout.

## Locked decisions

1. **One agnostic starter**, not an iOS shell. Authors delete web-marketing
   *content* they don't want; they do not maintain a structurally different shell.
   Shell is **capability-adaptive at runtime** (viewport / `display-mode` /
   presence of native bridge), not strip-at-author-time.
2. **We bless Capacitor config; author runs the toolchain.** Docs + example only,
   no Manifest-owned native CI.
3. **Framework-first.** Build the general capability layer; Nurvana consumes it and
   drives the riskier bridges (biometric, push, payments) as the proving ground.
4. **Capability-first plugins.** Each capability presents a web-degradable API;
   Capacitor is *one adapter*, never *the API*.
5. **Umbrella plugin family** (one Capacitor-detection core, individually
   registerable capabilities) — not N disconnected micro-plugins.
6. **`$device` base lives in core/utilities** (always-on: os / touch / online /
   standalone); the umbrella **enriches** the same store (native / platform /
   higher-fidelity online via Capacitor Network / insets). Web apps keep offline &
   OS reactivity without opting into the native plugin.
7. **IAP is out for Nurvana** → native payments = Apple Pay for **physical** goods
   through a real processor (3.1.3(e)-clean). StoreKit/digital-IAP is **docs-only**
   for now (explain the boundary so others don't trip 3.1.1).

## Codebase findings that shaped this

Verified by source read (2026-07-06). These correct/de-risk the original ask:

- **Prerender/hydration makes native PE free.** `manifest.js` restores authored
  Alpine attributes *before any plugin loads*; plugins are idempotent and always
  see authored DOM. There is **no "runtime-only plugin mode" to build** — a native
  plugin is a standard IIFE whose directives/magics **no-op when the native API is
  absent**. Web degradation is the default.
- **Payments has a client seam, not a backend one.** `$pay.register(name, adapter)`
  is a public magic; the server response drives modality
  (`{mode:'overlay', provider:'applepay'}`) —
  `src/scripts/payments/manifest.payments.*`. **But** the backend is a Revolut-only
  template (`templates/payments-function/`) and the MCP managed path is hardcoded
  (`z.enum(['revolut'])`). Native physical payments = client adapter (easy) **+** a
  backend provider sibling of `revolut.js` (contained).
- **Router is flat page-swap; no navigation stack.** `$route` magic + `x-route` +
  `manifest:route-change` make a bottom tab bar trivial today. Native push/pop
  **stack transitions do not exist** and need a layer *above* the router (plus
  per-screen lifecycle hooks it lacks). View Transitions only cross-fade. MPA/
  prerender mode disables SPA nav → any nav-chrome degrades to plain links (fine).
- **Status ≠ network.** `$status` is upstream *service-health* monitoring
  (`src/scripts/status/`). There is **no** `navigator.onLine`, no online/offline
  signal, no service worker anywhere. Connectivity must be its own signal — **do
  not overload `$status`**.
- **`detectOS()` already exists** — `src/scripts/utilities/manifest.utilities.init.js`
  stamps `<html data-os="ios|android|macos|windows|linux">` synchronously before
  paint, **honors an existing value** (prerenderer/manual/Capacitor can set it),
  and pairs with `@custom-variant` CSS variants (`ios:`, `android:`, `apple:`,
  `touch:`, …). It is **CSS-only** (no Alpine magic) and **can't distinguish web vs
  native** (a Capacitor iOS webview reads `data-os="ios"` like mobile Safari) —
  native detection keys off the injected `window.Capacitor` global.
- **Native-feel CSS mostly absent, good bones present.** Already: global
  tap-highlight removal, OS detection, responsive/touch-only utilities, RTL, and
  the **starter already ships `display: standalone`**. Missing: `env(safe-area-
  inset-*)`, `viewport-fit=cover`, `apple-mobile-web-app-*` meta, `overscroll-
  behavior`, opt-in `-webkit-touch-callout` suppression, `theme_color` in starter.
- **Offline is smaller than feared for native.** Capacitor serves the shell from
  the local bundle (`capacitor://`) → no white-screen for the shell. Real gap is
  persistent data across restarts (data cache is in-memory only) — a general Local
  Data concern, **deferred**, not native-specific. Prerender emits per-route static
  snapshots usable as offline/splash content.
- **Docs insertion is clean.** `articles/publishing/native-apps.md` is PWABuilder-
  centric with zero Capacitor / 4.2 / IAP content; articles register in
  `data/docs.yaml`, no frontmatter, `:::brand icon="lucide:…"` callouts.

## Bucket 1 — Agnostic primitives layer

Additive style + `<head>` meta; benefits mobile web, not just native. Opt-in where
it could harm content sites (never globally kill selection/zoom).

- **Safe-area layer** — `env(safe-area-inset-*)` tokens + utility classes (notch,
  Dynamic Island, home indicator). Pairs with `viewport-fit=cover`.
- **Meta additions** — `viewport-fit=cover`, `apple-mobile-web-app-capable`,
  `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title`; add
  `theme_color` to the starter manifest.
- **Web-tell suppression utilities** — `overscroll-behavior`, opt-in
  `-webkit-touch-callout`/tap-zoom/user-select suppression as **utility classes**,
  not global (mirrors existing element-scoped `user-select`/`touch-action` usage).
- **Bottom-tab nav convention** — documented pattern + optional styled component on
  the existing router (`$route` + `x-route` + active-state binding). Degrades to
  plain links in prerender.
- **Status bar / splash** — Capacitor-config-driven; splash can reuse prerender
  output for a branded first paint.

*Out of scope v1:* native push/pop **stack transitions** (needs a layer above the
flat router). Revisit as a Router enhancement; not required to clear 4.2.

## Bucket 2 — `$device` signal

Author intuition: OS-specific content and online/offline are both **device state**.
Extend the existing attribute-on-`<html>` + matching-CSS-variant pattern rather
than invent a parallel one.

**Attribute/variant layer** (extends `detectOS`): keep `data-os`; add reactive
`data-online="true|false"`, `data-standalone`, `data-native`; register matching
variants so authors get `offline:` / `native:` / `standalone:` alongside `ios:` —
full symmetry.

**Alpine layer** (new, thin, reads the same truth; store bumps on `online`/`offline`
events like the Status store):

```html
<div x-show="!$device.online">You're offline</div>
<template x-if="$device.os === 'ios'">…</template>
<div x-show="$device.native">…native-only affordance…</div>
```

`$device = { os, touch, online, standalone, native, platform }`.

- **Base** in core/utilities (`os`, `touch`, `online`, `standalone`) — always-on;
  web apps get offline/OS reactivity with no native opt-in.
- **Umbrella enriches** the same store: `native`, `platform` (web/ios/android via
  Capacitor), higher-fidelity `online` (Capacitor Network), later `insets`. One
  source of truth; the umbrella upgrades fidelity, never replaces the API.

Note `platform` (web vs native container) is distinct from `os` (ios vs macos).

## Bucket 3 — Native umbrella plugin

One opt-in plugin family; standard bootstrap (`initializeXPlugin` +
`ensureXInitialized` guard + `window` export + `alpine:init`/DOMContentLoaded/
immediate-check), conditional auto-injection via a `manifest.json` block (as
Payments/Chat/Appwrite do). Each capability **no-ops when its native API is
absent** → PE is free given the hydration contract.

Capabilities (capability-first: a web-degradable API with Capacitor as one adapter):

- **Biometric** (Face ID / Touch ID) — easiest single "this is native" win; gate sign-in or a sensitive action.
- **Secure storage** — Keychain/Keystore-backed token storage, its **own** capability (not folded into biometric). An app needs secure session-token storage independently of whether biometric is enabled; the Appwrite auth plugin currently falls back to `localStorage`, which a native adapter upgrades to the Keychain when present. Web fallback: `localStorage`/`IndexedDB`.
- **Push notifications** (APNs) — **three contracts, not display-only**, designed together and coupled to deep links + lifecycle:
  1. **Permission prompt timing** under author control (not auto-prompt on launch).
  2. **Device-token registration hook** — token → author's backend.
  3. **Notification-tap payload → router handoff** — deep-link the tap into a route (couples to deep links + lifecycle).
- **Deep links / universal links** — open the app to a specific route from a URL; shared handoff target with push taps.
- **Share** — native share sheet / Web Share API / clipboard fallback.
- **Haptics**.
- **Camera / photos**.
- **App lifecycle hooks** (foreground/background/resume) — also the delivery point for a tapped-notification payload.

**Proving-ground priority (Nurvana, framework-agnostic ordering aside):** the 4.2 "native-feel" ranking puts biometric first, but the first consumer's critical path is **push → deep links → share → secure storage** (internal TestFlight ~Jul 27, store submission Aug 4–6). Biometric + haptics are welcome riders (Face ID on slide-to-pay is a genuine luxury-feel + 4.2 win); camera can trail. Since capabilities are independent plugins, this only reorders the build sequence, not the design.

## Bucket 4 — Payments native adapter

Physical goods, Apple Pay, 3.1.3(e)-clean (no IAP). Reuses the existing client
seam:

- **Client:** `$pay.register('applepay', { supportsOverlay, open })` — no core
  change. Backend returns `{ mode:'overlay', provider:'applepay', … }`.
- **Backend:** write a provider **sibling of `revolut.js`** (same `createOrder` /
  `verifySignature` / `parseEvent` shape). Processor TBD (see open questions).
- **IAP boundary is docs-only:** digital goods/subscriptions inside a native app
  generally must use StoreKit (3.1.1). Nurvana avoids this by keeping digital/
  subscriptions web-billed and only shipping physical commerce natively. Document
  the physical-vs-digital line + current US external-link latitude so others don't
  accidentally route digital through a processor.

*Flag:* Polar is a merchant-of-record for **digital/SaaS** — likely won't serve a
**physical** leg. Stripe (with Apple Pay) is the natural physical-goods fit. If
Nurvana needs both, expect a split (Stripe physical / Polar or web-billed digital).

## Bucket 5 — Offline resilience

v1: Capacitor local bundle serves the shell (no white screen) + a branded offline
state bound to `$device.online`. Prerender output can back a branded splash/offline
page. **Defer** the persistent cross-restart data layer (in-memory cache today) —
general Local Data + service-worker work, not native-specific.

## Bucket 6 — Docs overhaul

Highest leverage; land first. House style: `articles/publishing/<topic>.md` +
`data/docs.yaml` entry, no frontmatter, `:::brand icon="lucide:…"` callouts,
`---`-separated sections.

- Reframe `native-apps.md`: PWABuilder = simplest but **4.2-risk on iOS**;
  **Capacitor = store-grade**. Keep other-OS packaging intact.
- New **App Store readiness / 4.2 guide** + checkbox **4.2 compliance checklist**.
- Payments physical-vs-digital / IAP boundary section.
- **Apple privacy manifests** — `PrivacyInfo.xcprivacy`, required-reason API declarations, and data-collection/tracking disclosures (mandatory since 2024, including for third-party SDKs like Capacitor plugins). Belongs in the readiness guide; it bites every author at submission otherwise.
- Per-capability plugin pages + `$device` page.

## Bucket 7 — Capacitor starter wrap

An **opt-in add-on to the standard starter** (Capacitor config + native scaffold),
**not** a separate starter. Documented; author runs Xcode/CLI. Wire prerender output
as the offline/splash shell where practical.

## Sequencing (by testability & stability, not timeline)

Front-load everything web-verifiable in the browser preview; mark native-only items
that need a simulator/device so manual/visual passes aren't blocked.

1. **Docs reframe** (native-apps.md honesty + Capacitor path). Cheap; unblocks
   Nurvana's submission thinking. No code risk.
2. **Primitives layer** — safe-area/meta/web-tells + starter `theme_color`. Fully
   testable via preview resize + `data-os` override. Visual.
3. **`$device` base signal** (core/utilities) — testable via devtools offline
   toggle + viewport. Web-verifiable.
4. **Bottom-tab nav convention** on the router — visual, web-verifiable.
5. **Native umbrella scaffold** + `$device` enrichment + first capabilities with
   web fallbacks (**share**, **network**) — fallbacks verifiable in browser.
6. **Capacitor starter wrap** proof → simulator/TestFlight. *Requires simulator.*
7. **Native-only capabilities** (biometric, haptics, push, camera, deep links,
   lifecycle) — web fallback first (browser-verifiable), native path *requires
   simulator/device*.
8. **Payments native adapter** — after processor decision; needs backend function.
9. **4.2 checklist + per-capability docs** — finalize against shipped behavior.

## Open questions

- **Nurvana payment processor** — undecided (investigating **Polar** and
  **Stripe**). Decides which backend provider sibling we write first. Polar likely
  can't do the physical leg (see flag above).
- **Stack transitions in v1?** Proposed *deferred*; confirm we're comfortable
  shipping tab-bar + primitives without native push/pop for the first native build.

## Non-goals

- No iOS-only template/shell.
- No Manifest-owned native build CI (author runs the toolchain).
- No StoreKit/digital-IAP integration in this pass (docs-only boundary).
- No persistent offline data layer in v1 (deferred to Local Data / SW work).

## Dogfood

Iterate primitives + `$device` on the **src test site** (fastest working surface;
existing `/virtual`, `/combobox` routes). Prove the actual **Capacitor wrap on the
starter template** — representative of the MCP author flow and already
`display: standalone`.
