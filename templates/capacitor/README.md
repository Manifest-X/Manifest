# Capacitor wrap (iOS-first)

Wrap a Manifest app as a store-grade native iOS app with [Capacitor](https://capacitorjs.com).
Unlike a thin PWABuilder WebKit wrapper, Capacitor gives you a real native project
with a plugin bridge — which is what makes iOS Guideline 4.2 achievable and what the
Manifest **native umbrella** plugin (`$share`, `$secure`, `$links`, `$push`, `$app`,
`$haptics`, `$biometric`, `$camera`) talks to.

This is a scaffold, not an automated tool — run the steps on a Mac with Xcode.

## Prerequisites

- macOS with **Xcode** + Command Line Tools, and **CocoaPods** (`sudo gem install cocoapods`)
- Node 18+
- An **Apple Developer** account ($99/yr) for signing, TestFlight, and the App Store

## 1. Opt the app into native capabilities

Add a `native` block to your `manifest.json` (an empty object is enough):

```json
{
  "native": {}
}
```

That loads `manifest.native.js` on the web build too (all capabilities degrade
gracefully off-device). Inside the Capacitor container it auto-loads regardless.

## 2. Build the web assets (the offline shell)

Capacitor ships whatever is in `webDir`. Prerender the app so the shell loads
instantly and offline (never a white screen — a Guideline 4.2 tell):

```bash
npx mnfst-render
```

This writes static output to `dist/` (matches `webDir` in `capacitor.config.json`).

## 3. Install Capacitor + this config

```bash
npm install @capacitor/core @capacitor/cli
npx cap init
```

Copy `capacitor.config.json` from this folder into your project root and set:
- `appId` — your reverse-DNS bundle id (e.g. `com.acme.nurvana`)
- `appName` — the display name
- `webDir` — leave as `dist` unless you render elsewhere

## 4. Install the capability plugins you use

Each Manifest `$`-magic maps to a Capacitor plugin. Install only what you need —
the magics no-op when their plugin is absent.

| Manifest magic | Capacitor plugin | Notes |
|---|---|---|
| `$share` | `@capacitor/share` | native share sheet |
| `$haptics` | `@capacitor/haptics` | |
| `$push` | `@capacitor/push-notifications` | APNs; needs the Push entitlement |
| `$app`, `$links` | `@capacitor/app` | lifecycle + `appUrlOpen` deep links |
| `$device.online` (network) | `@capacitor/network` | higher-fidelity connectivity |
| `$camera` | `@capacitor/camera` | |
| `$secure` | a secure-storage plugin registered as `SecureStorage` (e.g. `@aparajita/capacitor-secure-storage`) | Keychain-backed; use `$secure.use(adapter)` if your plugin's API differs |
| `$biometric` | a biometric plugin (e.g. `capacitor-native-biometric` or `@aparajita/capacitor-biometric-auth`) | Face ID / Touch ID |

```bash
npm install @capacitor/share @capacitor/haptics @capacitor/app @capacitor/network \
  @capacitor/push-notifications @capacitor/camera
# plus your chosen secure-storage and biometric plugins
```

## 5. Add iOS and sync

```bash
npx cap add ios
npx cap sync ios
```

Re-run `npx mnfst-render && npx cap sync ios` whenever the web app changes.

## 6. Configure Info.plist and entitlements

In Xcode (`npx cap open ios`), under the app target:

- **Usage strings** (required or the app crashes on first use):
  - `NSCameraUsageDescription` — for `$camera`
  - `NSPhotoLibraryUsageDescription` / `NSPhotoLibraryAddUsageDescription`
  - `NSFaceIDUsageDescription` — for `$biometric`
- **Push:** add the *Push Notifications* capability and *Background Modes → Remote notifications*.
- **Deep links:** add *Associated Domains* (`applinks:yourdomain.com`) for universal links, or a custom URL scheme for `myapp://` links — both arrive via `$links`.
- **Privacy manifest:** add `PrivacyInfo.xcprivacy` declaring data collection + required-reason API codes (mandatory since 2024, and covered SDKs like Capacitor plugins ship their own). See the [App Store Readiness guide](https://manifestx.dev/docs/publishing/app-store-readiness).

## 7. Native feel (already mostly handled by Manifest)

- `viewport-fit=cover` and `apple-mobile-web-app-*` meta ship in the starter `<head>`.
- Use the safe-area utilities (`p-safe`, `pb-safe`, `--safe-*`) and `<nav dock>` so
  content clears the notch and home indicator.
- `StatusBar.overlaysWebView` + the `SplashScreen` config above remove the white
  launch flash and browser chrome.

## 8. Run, then ship

```bash
npx cap open ios
```

Set your signing team, run on a simulator/device, then Archive → upload to
**TestFlight**. Before submitting, self-audit against the
[iOS 4.2 checklist](https://manifestx.dev/docs/publishing/app-store-readiness) —
ship at least one genuine native capability (Face ID, push, camera, or share) and
name it in the review notes so the reviewer finds it.

## Payments note

Physical goods may use Apple Pay / a normal processor in-app (Guideline 3.1.3(e)).
Digital goods and subscriptions consumed in-app must use In-App Purchase (3.1.1) —
keep those web-billed and outside the app. See the readiness guide.
