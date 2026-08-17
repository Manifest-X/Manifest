# Docs template

A documentation site built with Manifest: sidebar navigation, markdown articles,
⌘K search, group landing pages, an "On this page" list, and prerender-ready SEO.
No build step and no custom JavaScript — the components are HTML.

## Use it standalone

```bash
npx mnfst-run .        # serve
npx mnfst-render .     # prerender to /website for hosting
```

## Use it inside a larger site

The docs are four components mounted on one route. Copy `components/`, `data/`,
and `articles/` into your project, register the components in your
`manifest.json`, then mount:

```html
<x-docs-search></x-docs-search>
<x-docs-nav></x-docs-nav>

<main>
  <x-your-marketing-home x-route="/"></x-your-marketing-home>
  <x-docs x-route="docs" intro="Guides and reference."></x-docs>
</main>
```

Your own header stays yours — it only needs two controls, anywhere in the page:

```html
<button popovertarget="docs-search">Search</button>          <!-- opens ⌘K dialog -->
<button popovertarget="docs-nav" class="md:hidden">Menu</button>  <!-- mobile nav -->
```

## Props

Every component takes the same two, so the docs can live at any path and read
any data source:

| Prop | Default | Meaning |
|---|---|---|
| `base` | `/docs` | URL prefix the docs are mounted at — must match the `x-route` |
| `source` | `docs` | `manifest.json` data key holding the nav tree |
| `heading` | `Docs` | Title on the docs home page (`<x-docs>` only) |
| `intro` | — | Sentence under that title (`<x-docs>` only) |

Mounting at `/help` from a `helpTree` source:

```html
<x-docs x-route="help" base="/help" source="helpTree" heading="Help"></x-docs>
<x-docs-nav base="/help" source="helpTree"></x-docs-nav>
<x-docs-search base="/help" source="helpTree"></x-docs-search>
```

## Content

`data/docs.yaml` is the whole contract — one entry per article:

```yaml
- group: "Getting Started"
  slug: "getting-started"           # URL segment
  description: "Shown on the group landing page."
  items:
    - name: "Introduction"          # omit `name` to hide from navigation
      path: "introduction"          # URL segment
      icon: "lucide:book-open"      # any Iconify name
      doc: "/articles/getting-started/introduction.md"
      indent: false                 # optional, sub-item styling
```

Articles are plain markdown. `h2`/`h3` headings populate the page's anchor list.

## Styling

Everything is driven by theme tokens in `manifest.theme.css` — colors, fonts,
radii, spacing. There is no docs-specific stylesheet to fight, so restyling the
whole site means editing variables, not components.

`manifest.theme.css` also carries static copies of the docs shell's layout
utilities. Variants of semantic classes are compiled at runtime and can land
after first paint, which would briefly collapse the shell to a single column;
those few rules keep the structure correct from the first frame.

## Overriding

Components resolve locally first, so replacing one is copying that file and
editing it — the rest keep working. `components/docs-footer.html` exists for
exactly this: it is the chrome under every article (branding, links, color-mode
switch), deliberately small and meant to be replaced.

## Prerendering

`npx mnfst-render .` writes a static page per article plus the docs home and one
per group, with per-page metadata, Open Graph images, breadcrumbs, `sitemap.xml`,
and `llms.txt` / `llms-full.txt` for AI crawlers. The search index is built in
the browser from the same article files — no build step, nothing to keep in sync.
