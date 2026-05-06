---
name: manifest-page
description: Use when the contributor wants to add, edit, rename, or remove a page in a Manifest project — including static pages and template pages (one routed element that renders different content per URL slug from a data source, e.g. /blog/<slug>, /team/<member>, /products/<id>). Triggers on phrases like "add a page", "create a [topic] page/section", "make a /pricing page", "add a blog with individual post pages", "make a team-member detail page", "rename the about page", "delete the FAQ page". Pages are any element with an x-route attribute — they can live in index.html, in components, or nested anywhere. SKIP for one-off copy edits inside an existing page.
---

# Adding or modifying a page in Manifest

A "page" in Manifest is **any element with an `x-route` attribute** — there is no separate page file. The router shows or hides the element based on the URL. Routes can be on a `<section>`, a `<div>`, a `<x-component>`, anything — and they can live in `index.html`, inside a component file, or nested arbitrarily deep. The starter template puts top-level pages as `<section>` children of `<main>` in `index.html`, but that's a convention, not a rule.

There are two flavours of page to recognise:
- **Static pages** — fixed content, one routed element per URL. The default case.
- **Template pages** — one routed element renders different content based on the URL slug, with content pulled from a data source (e.g. blog posts, team members, products). Same element, many URLs. See "Template pages" below.

## Recipe

1. **Find this project's pattern first.** Don't assume the starter layout. Grep for `x-route` across the project to see where pages already live:
   ```
   rg 'x-route=' --type=html
   ```
   Look at the surrounding HTML to learn:
   - Are top-level pages in `index.html`, or in a layout component?
   - Are pages `<section>`s, `<div>`s, or `<x-component>`s? (Match the existing element type.)
   - What classes/structure do they use? (Match it for visual consistency.)
   - Are subroutes nested inside their parent route's element, or flat?

   When in doubt — or for a brand-new project that still looks like the starter — top-level pages be elements in `index.html`.

2. **Pick the route.** Translate what the user said into a URL slug:
   - "pricing page" → `x-route="pricing"`
   - "homepage" → `x-route="/"`
   - "404 / not found" → `x-route="!*"`
   - Subroute under existing path → `x-route="parent/child"`

   Route grammar:
   - `x-route="/"` — root only
   - `x-route="about"` — `/about` and any subroutes
   - `x-route="=about"` — exact `/about`
   - `x-route="about/*"` — subroutes only
   - `x-route="!admin"` — everywhere except `/admin`
   - `x-route="!*"` — fallback (404)

3. **Pick the location.** Based on what step 1 found:
   - **Top-level page** in a project that follows the starter → add to `index.html`.
   - **Top-level page** in a project that uses a layout component (e.g. `components/page.html`) → add inside that component.
   - **Subroute** of an existing page → if the existing pattern nests subroutes inside the parent's element, follow that. Otherwise add as a sibling with `x-route="parent/child"`.
   - **A page that's really a reusable component** (cards, modals, sections used in multiple routes) → use the **manifest-component** skill instead.

4. **Insert the element** in the matching style. Default scaffolds (adapt to the project's convention):
   ```html
   <section x-route="<route>">
     <h1>Heading</h1>
     <p>Body copy.</p>
   </section>
   ```
   For a markdown-driven page: `<section x-route="<route>" x-markdown="'<file>.md'"></section>` — note the apostrophes inside the quotes; `x-markdown` evaluates as an Alpine expression, so the file path must be a string literal.
   For a page composed of components: `<div x-route="<route>"><x-hero></x-hero><x-pricing-table></x-pricing-table></div>`

5. **Update navigation** if there is one. Look for `<a href="/...">` patterns in the header, footer, or nav components and add a matching link. If no nav links to the new route, ask whether to add one.

6. **Per-page `<head>` metadata** (optional, website projects). Inside the routed element, add `<template data-head>...</template>` with the meta tags that should apply when this page is active. For full SEO patterns (titles, OG tags, dynamic per-slug metadata for template pages), use the **manifest-seo** skill.

7. **Renaming a page**: change the `x-route` value, update any `<a href>` references, and rename related files (e.g. markdown source) if applicable. Warn the user that the URL will change — anyone with the old link will hit a 404.

8. **Removing a page**: delete the routed element, remove nav links, and delete any orphan markdown/component files it referenced.

9. **Verify in the preview panel.** After the edit, navigate to the route and confirm the page renders. Report what the user will see.

## Template pages (dynamic content from a data source)

When the contributor says "add a blog where each post has its own page", "make individual product pages", "give each team member a detail page" — that's a template page. **One routed element renders many URLs**, with content driven by a data source matched against the URL slug.

**Pattern:**

```html
<!-- One element, matches /blog/anything -->
<article x-route="blog/*" x-show="$x.posts.$route('slug')">
  <h1 x-text="$x.posts.$route('slug').title"></h1>
  <small x-text="$x.posts.$route('slug').date"></small>
  <div x-markdown="$x.posts.$route('slug')?.body"></div>
</article>

<!-- 404 fallback when slug doesn't match -->
<section x-route="blog/*" x-show="!$x.posts.$route('slug')">
  <h1>Post not found</h1>
</section>
```

The data source registered in `manifest.json`:
```json
"data": { "posts": "/data/posts.json" }
```

With each item having a `slug` field (the URL segment to match):
```json
[
  { "slug": "first-post", "title": "First Post", "date": "2026-01-01", "body": "/data/posts/first-post.md" },
  { "slug": "second-post", "title": "Second Post", "date": "2026-02-01", "body": "/data/posts/second-post.md" }
]
```

**How it works:**
- `x-route="blog/*"` matches `/blog/anything`
- `$x.posts.$route('slug')` searches `posts` for an item whose `slug` field matches a URL segment — returns the matching item, or empty if none
- The `body` field can be inline markdown OR a path to a `.md` file (the markdown plugin handles both)

**Recipe:**

1. **Register the data source** in `manifest.json` if not already done. Use the `manifest-data` skill if needed.
2. **Decide the slug field name** — `slug` is conventional, but any field works (`path`, `id`, `handle`).
3. **Add the routed element** with `x-route="<base>/*"` (e.g. `blog/*`, `team/*`, `products/*`).
4. **Bind the content** with `$x.<source>.$route('<field>')`.
5. **Add a list/index page** at the parent route showing all items linking to their detail pages:
   ```html
   <section x-route="=blog">
     <h1>Blog</h1>
     <ul>
       <template x-for="post in $x.posts" :key="post.slug">
         <li><a :href="`/blog/${post.slug}`" x-text="post.title"></a></li>
       </template>
     </ul>
   </section>
   ```
   `x-route="=blog"` is exact-match, so `/blog` shows the index, `/blog/foo` shows the detail.
6. **For SEO on website projects**, add a `<template data-head>` inside the routed element with `:title`/`:meta` bindings driven by `$route()` so each detail URL gets its own `<head>` metadata.
7. **Verify** by visiting two different slugs and confirming the content swaps.

## What not to do

- **Don't assume the starter layout.** Check what the project actually does first.
- **Don't add JavaScript routers**, `history.pushState` handlers, or build-step routing — Manifest's router is purely the `x-route` attribute.
- **Don't pre-render manually** — `/staging` handles render for website projects.
- **Don't create a separate HTML file per page** unless the project already does so via a layout-component pattern (in which case use **manifest-component** to add it).

## Further reading

If the recipe above doesn't cover the situation, consult:
- Router (full route grammar, `$route` magic): https://manifestjs.org/docs/core-plugins/router
- Components (used as page-level layouts): https://manifestjs.org/docs/core-plugins/components
- Markdown (for markdown-driven pages): https://manifestjs.org/docs/core-plugins/markdown
