---
name: manifest-seo
description: Use when the contributor wants to improve search-engine visibility, control how a page looks when shared on social media, set page titles, add Open Graph tags, configure the favicon, or audit per-page metadata. Triggers on "improve SEO", "set the page title", "fix the share preview", "add Open Graph", "add a meta description", "set up the favicon", "make this look right when posted on Twitter/Slack/iMessage". Manifest's pattern: per-page `<head>` injection via `<template data-head>` inside each routed element. SKIP for runtime UI feedback like toasts (use manifest-form).
---

# Managing SEO and per-page metadata in Manifest

Manifest gives each routed element its own `<head>` injection via `<template data-head>`. When the route is active, the meta tags inside that template merge into the document `<head>`. For prerendered website projects, this gets baked into the static HTML output; for SPAs, the DOM updates at runtime.

## Step 0 — find the existing pattern

**Always do this first.** Open `index.html` and grep for `<template data-head>`. Most starter projects have one global head template inside `<body>` (with `<meta name="description">`, OG tags, etc.) and may have per-page templates inside specific routed elements.

```
rg 'data-head' --type=html
```

If there's no `<template data-head>` anywhere, the project relies on whatever's in the static `<head>` — every page shares the same metadata. That's fine for an SPA tool but bad for SEO on multi-page websites.

## Recipe

### Adding or fixing the global head metadata

The starter pattern lives in `<body>` as a `<template data-head>` with bindings to `$x.manifest` (data from `manifest.json`):

```html
<template data-head>
  <meta name="author" :content="$x.manifest.author">
  <meta name="description" :content="$x.content.description">
  <meta property="og:title" :content="$x.manifest.name">
  <meta property="og:description" :content="$x.content.description">
  <meta property="og:url" :content="$x.manifest.live_url">
  <meta property="og:site_name" :content="$x.manifest.name">
  <meta property="og:image" content="/icons/opengraph.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" :content="$x.manifest.name">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="en-us">
</template>
```

When the contributor asks about site-wide SEO ("set the description", "fix the OG image"), edit `manifest.json` (for `name`, `author`, `description`, `live_url`) — those flow through automatically. For the OG image itself, replace `/icons/opengraph.png` (1200×630 is the recommended size).

### Adding per-page metadata

When a specific page needs its own title or description ("the about page should say X for SEO"), add a `<template data-head>` **inside that page's routed element**:

```html
<section x-route="about">
  <template data-head>
    <title>About Us — Acme</title>
    <meta name="description" content="The story behind Acme.">
    <meta property="og:title" content="About Acme">
    <meta property="og:description" content="The story behind Acme.">
  </template>
  <h1>About</h1>
  <p>...</p>
</section>
```

Per-page templates **merge** with the global template — only set the tags that differ.

### Per-page metadata for template pages (dynamic content)

When the page content comes from a data source (blog posts, products, team members), bind the meta tags to the matched item:

```html
<article x-route="blog/*">
  <template data-head>
    <title :content="$x.posts.$route('slug').title + ' — Blog'"></title>
    <meta name="description" :content="$x.posts.$route('slug').excerpt">
    <meta property="og:title" :content="$x.posts.$route('slug').title">
    <meta property="og:description" :content="$x.posts.$route('slug').excerpt">
    <meta property="og:image" :content="$x.posts.$route('slug').coverImage">
  </template>
  <h1 x-text="$x.posts.$route('slug').title"></h1>
  <!-- ... -->
</article>
```

For website projects, the prerender bakes a unique `<head>` per URL — so each blog post gets its own crawlable, share-previewable HTML.

### `<title>` specifically

The browser tab uses `<title>` from the document head. Setting it per-page via `<template data-head><title>...</title></template>` updates the tab title when the route changes. If the project also wants social-card-friendly titles, set both `<title>` and `<meta property="og:title">`.

### Sitemap and robots.txt

For **website projects** (those that run `mnfst-render`), `sitemap.xml` and `robots.txt` are **generated automatically** based on routes and `prerender.liveUrl` in `manifest.json`. Don't try to write or maintain them by hand.

For **SPAs** (no render step), there's no auto-sitemap — search engines crawl the rendered DOM. If SEO is critical for an SPA, recommend converting it to a website project.

### Verify

1. Reload the preview and inspect the document `<head>` — the per-page metadata should be present.
2. Use a share-preview validator (LinkedIn Post Inspector, Twitter Card Validator, OpenGraph.xyz) once the site is live — quick way to catch missing tags.
3. For prerendered output, open the static HTML for a specific URL in `/website/<route>/index.html` and confirm the `<head>` is baked correctly.

## What not to do

- **Don't put per-page meta tags directly in the static `<head>`** in `index.html` — they'll apply to every route. Use `<template data-head>` inside the routed element.
- **Don't hardcode the live URL** in OG tags — bind to `$x.manifest.live_url` so the value comes from one place.
- **Don't forget `og:image:width` and `og:image:height`** — Facebook in particular needs them for the share card to render correctly. 1200×630 is the canonical size.
- **Don't try to manage `sitemap.xml` manually** for website projects — `mnfst-render` generates it from routes. Manual edits get overwritten on the next render.
- **Don't add SEO content that contradicts the page content** — search engines penalise meta-vs-content mismatch and users feel deceived.
- **Don't skip `alt` text on images.** Both an SEO and accessibility concern.

## Further reading

If the recipe above doesn't cover the situation, consult:
- Components & `<template data-head>` (full head-injection mechanics): https://manifestjs.org/docs/core-plugins/components
- Router (route matching, including `*` wildcards for template pages): https://manifestjs.org/docs/core-plugins/router
- Websites publishing (prerender, sitemap, robots): https://manifestjs.org/docs/publishing/websites
