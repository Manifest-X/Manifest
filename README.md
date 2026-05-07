# Manifest

Manifest is a frontend framework extending HTML for rapid, feature-rich website and web app development, consisting of:

- A collection of plugins built on Alpine JS
- A CSS library, compatible with Tailwind CSS

**With Manifest:**
- Build steps optional
- Use only what you need
- Stack with other frameworks & libraries

<br>

## 💾 Setup

Get [CDN links](https://manifestjs.org/getting-started/setup) for existing projects or try the [starter project](https://manifestjs.org/getting-started/starter-project) for new ones.

<br>

## ✅ Features

**Alpine Plugins:**
- Color Themes
- Components
- Data Sources
- Localization
- SPA Routing

**UX/UI:**
- Global Theme
- Utility Classes
- 20+ Elements

**...and more**

<br>

## 📚 Documentation

For full documentation visit [manifestjs.org](https://manifestjs.org).

<br>

## 📦 Publishing

Each package publishes independently to npm. The `release:*` scripts auto-bump the patch version (e.g. `0.5.65 → 0.5.66`) and publish — no manual version edits needed. The bump is **not** auto-committed, so it lands in your working tree alongside whatever changes triggered the release.

| Command | Package | Path |
|---|---|---|
| `npm run release` | `mnfst` | (root) |
| `npm run release:run` | `mnfst-run` | `packages/run/` |
| `npm run release:render` | `mnfst-render` | `packages/render/` |
| `npm run release:starter` | `mnfst-starter` | `packages/create-starter/` |

Run only the scripts whose package you actually changed.

For a **minor** or **major** bump, run `npm version minor` (or `major`) inside the relevant package directory before publishing:
```sh
cd packages/render
npm version minor --no-git-tag-version
npm publish --auth-type=web
```

After publishing, commit the version bump(s) along with your changes and push.

<br>

## 📄 License

Manifest is provided under MIT license.
