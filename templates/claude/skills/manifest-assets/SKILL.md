---
name: manifest-assets
description: Use when the contributor wants to add, replace, or organise images, icons, the favicon, fonts, or other static media. Triggers on "add this image", "replace the favicon", "use the Inter font", "make this image responsive", "add a hero image", "swap the logo", "use Google Fonts", "change the app icon". Manifest doesn't have a special asset pipeline — files are served as-is from the project, referenced by `<img>`, `<link>`, etc. SKIP for SVG icons that are part of an icon set (use `x-icon="lucide:name"` directly — no file needed).
---

# Working with assets in Manifest

Manifest has no asset bundler — files are served from the project as-is and referenced by URL. The work is mostly choosing where files live, naming them sensibly, and using the right HTML element.

## Step 0 — find the existing pattern

**Always do this first.** Look at where existing assets live in the project:

```
ls icons/ assets/ fonts/ 2>/dev/null
rg 'src=|href=' index.html components/*.html | head -20
```

The starter convention:
- `/icons/` — app icons (PWA), Open Graph image
- `/assets/` — content images (heroes, illustrations, photos)
- Root level — `favicon.ico` only

Match whatever the project actually uses. If it has its own structure (e.g. `/public/`, `/static/`, `/img/`), follow that.

## Recipe — images

1. **Decide the location.** Match the existing convention; default to `/assets/<category>/<name>.<ext>` (e.g. `/assets/team/founder.webp`).
2. **Pick the format.** Modern: `.webp` (smaller, near-universal browser support). Fallback: `.jpg` for photos, `.png` for graphics with transparency, `.svg` for vector. **For new images prefer `.webp` unless there's a reason not to.**
3. **Reference with `<img>`.** Manifest's CSS reset gives `<img>` a sane default (max-width: 100%, height: auto). For most cases that's all you need:
   ```html
   <img src="/assets/team/founder.webp" alt="Sarah Chen, founder">
   ```
4. **Always include `alt` text.** A short description for accessibility and SEO. For purely decorative images, use `alt=""` (empty, but present — tells screen readers to skip it).
5. **For hero / banner sizing**, use Tailwind aspect utilities or CSS variables:
   ```html
   <img src="/assets/hero.webp" alt="..." class="w-full aspect-video object-cover">
   ```
6. **For responsive art direction** (different image per viewport — e.g. portrait crop on mobile), use `<picture>`:
   ```html
   <picture>
     <source media="(max-width: 768px)" srcset="/assets/hero-portrait.webp">
     <img src="/assets/hero.webp" alt="..." class="w-full">
   </picture>
   ```
7. **Verify in the preview panel** at multiple widths via `preview_resize`. Check the image renders, isn't pixelated, and the alt text is present (inspect element).

## Recipe — favicon

1. **The starter ships `favicon.ico` at the project root** referenced by `<link rel="icon" href="/favicon.ico" sizes="any">`. Replace the file with the contributor's icon to update.
2. **For higher-resolution displays**, also provide a PNG:
   ```html
   <link rel="icon" type="image/png" href="/icons/favicon-32.png" sizes="32x32">
   <link rel="icon" type="image/png" href="/icons/favicon-16.png" sizes="16x16">
   <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
   ```
3. **For PWA install prompts**, update the `icons` array in `manifest.json`:
   ```json
   "icons": [
     { "src": "/icons/192x192.png", "sizes": "192x192", "type": "image/png" },
     { "src": "/icons/512x512.png", "sizes": "512x512", "type": "image/png" }
   ]
   ```
4. **Open Graph share image** (the preview when posting on social media): `/icons/opengraph.png` at 1200×630, referenced in the `<template data-head>` (see the **manifest-seo** skill).

If the contributor only has one image (a logo), tell them what sizes you'll generate — favicon needs at least 32×32 and 192×192. Don't generate placeholder content; ask for the source and convert.

## Recipe — fonts

The default `--font-sans` in `manifest.theme.css` is the system font stack — fast, no download, looks native. Override only if there's a brand reason to.

### Google Fonts (easiest)

1. **Add the `<link>` to `<head>`** in `index.html`:
   ```html
   <link rel="preconnect" href="https://fonts.googleapis.com">
   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
   <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap">
   ```
2. **Update `--font-sans`** in `manifest.theme.css`:
   ```css
   --font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;
   ```
3. **Verify** the font loads — browser inspect → Network tab should show the font file.

### Self-hosted (faster, no third-party request)

1. **Download the font files** (`.woff2` recommended) into `/fonts/`.
2. **Add `@font-face` rules** to `manifest.theme.css` or a separate stylesheet:
   ```css
   @font-face {
     font-family: 'Inter';
     src: url('/fonts/Inter-Regular.woff2') format('woff2');
     font-weight: 400;
     font-display: swap;
   }
   ```
3. **Update `--font-sans`** as above, or a new variable applied to respective text elements.

For mono fonts (code blocks), set `--font-mono` similarly.

## Recipe — SVG

- **For icons from a set** (e.g. Lucide, MDI, Simple Icons): use `x-icon="lucide:name"` — no file needed, fetched on demand from Iconify. Don't download SVGs for these.
- **For brand logos and custom illustrations**: store as `.svg` files and reference via `<img src="/assets/logo.svg" alt="...">` or inline the SVG markup if you need to style its parts via CSS.
- **Inline SVG** is fine for small custom shapes — it avoids a separate request and is stylable. Don't inline large SVGs (bloats HTML).

## What not to do

- **Don't commit unoptimised images.** A 5MB hero image hurts page speed. Compress before adding (Squoosh, ImageOptim, or `cwebp` for WebP). For photos, target ≤200KB; for above-the-fold heroes, ≤500KB.
- **Don't reference external CDN images** (e.g. unsplash.com URLs) in production unless you have permission and accept the dependency. The site goes down when the CDN does.
- **Don't put assets in `/lib/`** — that's the framework directory.
- **Don't skip `alt` text.** Even decorative images need `alt=""` to be explicit.
- **Don't download an icon when `x-icon="lucide:name"` works.** Iconify has 200k+ icons; check the Iconify search before adding a file.
- **Don't include `width` and `height` attributes that mismatch the actual image.** They tell the browser to reserve layout space — wrong values cause layout shift.
- **Don't load 12 weights from Google Fonts** when you only use 2. Each weight is a separate download. List only the weights you actually use.

## Further reading

If the recipe above doesn't cover the situation, consult:
- Reset (default `<img>`, `<picture>`, `<svg>` styling): https://manifestjs.org/docs/styles/reset
- Theme (`--font-sans`, `--font-mono` variables): https://manifestjs.org/docs/styles/theme
- Icons (Iconify usage, icon sets): https://manifestjs.org/docs/elements/icons
- SVGs: https://manifestjs.org/docs/elements/svgs
