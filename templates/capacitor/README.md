# Capacitor wrap (iOS-first)

Wrap a Manifest app as a store-grade native iOS app with [Capacitor](https://capacitorjs.com).
Unlike a thin PWABuilder WebKit wrapper, Capacitor gives you a real native project
with a plugin bridge — which is what makes iOS Guideline 4.2 achievable and what the
Manifest **device** plugin (`$share`, `$secure`, `$links`, `$push`, `$app`,
`$haptics`, `$biometric`, `$camera`) talks to.

This is a scaffold, not an automated tool — run the steps on a Mac with Xcode.

## Prerequisites

- macOS with the latest **Xcode** + Command Line Tools (see Capacitor's [environment setup](https://capacitorjs.com/docs/getting-started/environment-setup))
- **Node 22+** — the Capacitor 8 CLI requires it (`engines: >=22`)
- No CocoaPods needed: `npx cap add ios` uses Swift Package Manager by default since Capacitor 8 (pass `--packagemanager CocoaPods` only for plugins that ship no `Package.swift`)
- iOS 15+ deployment target (Capacitor 8's default)
- An **Apple Developer** account ($99/yr) for signing, TestFlight, and the App Store

## 1. Opt the app into device capabilities

Add a `device` block to your `manifest.json` (an empty object is enough):

```json
{
  "device": {}
}
```

That loads `manifest.device.js` on the web build too (all capabilities degrade
gracefully off-device). Inside the Capacitor container it auto-loads regardless.

## 2. Install Capacitor + this config

```bash
npm install @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android \
  @capacitor/splash-screen @capacitor/status-bar
npm install -D mnfst-render@^0.5.48
```

Drop `@capacitor/android` if you only ship iOS. The splash-screen and status-bar
plugins back the `SplashScreen` and `StatusBar` entries in the config.

Copy `capacitor.config.json` from this folder into your project root and set:
- `appId` — your reverse-DNS bundle id (e.g. `com.acme.app`); it can't change after the first store upload
- `appName` — the display name (`short_name` from `manifest.json`)
- `webDir` — leave as `.app-www`
- `plugins.PushNotifications` — add `{ "presentationOptions": ["badge", "sound", "alert"] }` only if you use `$push`

## 3. Build the web assets (the offline shell)

Capacitor ships whatever is in `webDir`. Prerender the app into it so the shell
loads instantly and offline (never a white screen — a Guideline 4.2 tell). Merge
these scripts into `package.json`:

```json
"scripts": {
  "app:web": "mnfst-render --out .app-www",
  "app:build": "npm run app:web && npx cap sync"
}
```

Render into the dot-folder `.app-www`, never `website/`: a `website/` folder
switches an SPA project's publish into render mode, and non-dot folders get
copied into later renders. With a `capacitor.config.*` at the root, `mnfst-render`
0.5.48+ leaves `ios/`, `android/` and the Capacitor config out of its output, and
an `--out` render skips the project's regular `website/` output too.

Keep the build and native files out of git noise and out of the website:

```gitignore
# .gitignore
node_modules/
.app-www*
```

```gitignore
# .manifestignore
/ios/
/android/
/capacitor.config.*
/.app-www*
/package.json
/package-lock.json
```

Commit `ios/` and `android/`; Capacitor writes its own `.gitignore` in each.

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
| `$secure` | `@aparajita/capacitor-secure-storage` | Keychain/Keystore; values stored under its default `capacitor-storage_` prefix. Other plugins: `$secure.use(adapter)` |
| `$biometric` | `@aparajita/capacitor-biometric-auth` or `@capgo/capacitor-native-biometric` | Face ID / Touch ID |

```bash
npm install @capacitor/share @capacitor/haptics @capacitor/app @capacitor/network \
  @capacitor/push-notifications @capacitor/camera \
  @aparajita/capacitor-secure-storage @aparajita/capacitor-biometric-auth
```

## 5. Add the platforms

```bash
npm run app:web
npx cap add ios
npx cap add android   # optional
```

Run `npm run app:build` whenever the web app changes.

## 6. Configure Info.plist and entitlements

In Xcode (`npx cap open ios`), under the app target:

- **Usage strings** (required or the app crashes on first use):
  - `NSCameraUsageDescription` — for `$camera`
  - `NSPhotoLibraryUsageDescription` / `NSPhotoLibraryAddUsageDescription`
  - `NSFaceIDUsageDescription` — for `$biometric`
- **Push:** add the *Push Notifications* capability and *Background Modes → Remote notifications*.
- **Deep links:** add *Associated Domains* (`applinks:yourdomain.com`) for universal links, or a custom URL scheme for `myapp://` links — both arrive via `$links`. Put `apple-app-site-association` (and Android's `assetlinks.json`) in a `.well-known/` folder at the project root; it publishes in SPA and render mode (`mnfst-render` 0.5.56+ copies `.well-known`, and no other dot-folder).
- **Privacy manifest:** add `PrivacyInfo.xcprivacy` declaring data collection + required-reason API codes (mandatory since 2024, and covered SDKs like Capacitor plugins ship their own). See [Passing review](https://manifestx.dev/docs/framework/publishing/native-apps#passing-review).

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
[Passing review checklist](https://manifestx.dev/docs/framework/publishing/native-apps#passing-review) —
ship at least one genuine native capability (Face ID, push, camera, or share) and
name it in the review notes so the reviewer finds it.

## Payments note

Physical goods may use Apple Pay / a normal processor in-app (Guideline 3.1.3(e)).
Digital goods and subscriptions consumed in-app must use In-App Purchase (3.1.1) —
keep those web-billed and outside the app. See [Passing review](https://manifestx.dev/docs/framework/publishing/native-apps#passing-review).
