# Websites
Publish Manifest projects live to the web.

---

## Default (SPA)

Manifest projects function as a single page application (SPA) by default, using JavaScript for routing. To deploy live on a host environment:

- Deploy the project root directory
- Set the root to `./` if applicable
- Set the fallback file to `./index.html` if applicable

The [starter project](/docs/getting-started/starter-project) includes a `_redirects` file to assist the host with SPA routing.

---

## Optimized (MPA)

Search engines and AI crawlers will execute limited or no JavaScript when indexing websites, effectively rendering SPAs invisible. To adapt, Manifest provides a CLI build script to generate a multi-page application (MPA), where every route is represented by a static, crawlable `index.html`.

### Prerendering

The CLI build script prerenders your SPA into an MPA. From the project root run:

```bash copy
npx mnfst-render
```

By default, output is generated in a `/website` folder which includes:

- Copies of all folders and assets from the project, preserving path references.
- Folders for each route containing its compiled `index.html` page.
- Folders for each locale (e.g. `/fr`, `/zh`), and page sub-folder as applicable.
- Translated text content on locale pages (from CSV or YAML/JSON data sources).
- Locale-prefixed navigation links on locale pages (e.g. `/fr/pricing`).
- Canonical and hreflang links added to each page.
- `og:locale`/`og:locale:alternate` for localized builds when Open Graph tags exist.
- Compiled Tailwind CSS (when `data-tailwind` is used).
- `sitemap.xml` and `robots.txt` files.

---

### Configuration

Use `manifest.json` to optionally customize the MPA build. The `live_url` top-level key sets the domain used in `sitemap.xml`, `robots.txt`, and canonical link tags.

```json "manifest.json" copy
{
  "live_url": "https://example.com",
  "prerender": {
    "output": "website",
    "routerBase": "",
    "locales": ["en", "fr", "zh"],
    "paths": ["legal/privacy", "legal/terms"],
    "localeRouteExclude": ["legal"],
    "redirects": [
      { "from": "/old", "to": "/new", "status": 301 }
    ],
    "wait": 15000,
    "concurrency": 2,
    "retries": 2,
    "browserRecycleEvery": 40,
    "tailwindInput": "styles/tailwind.css"
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `output` | `string` | `"website"` | Output folder name relative to the project root. |
| `routerBase` | `string` | `""` | Base path baked into asset references in prerendered HTML. Leave empty when the output is deployed as the site root. |
| `locales` | `string[]` | auto-discovered | Locale codes to build (e.g. `["en", "fr", "zh"]`). When omitted, locales are inferred from your data source keys or CSV column headers. Set to `["en"]` (your default locale only) to skip locale folder generation when only specific pages use translated example data. |
| `paths` | `string[]` | `[]` | Additional paths to render beyond those auto-discovered from `x-route` attributes (e.g. `["legal/privacy"]`). Each entry is expanded to all locale variants. |
| `localeRouteExclude` | `string[]` | `[]` | Route prefixes that should not receive locale variants (e.g. `["legal"]` keeps `/legal/terms` as-is without generating `/fr/legal/terms`). |
| `redirects` | `object[]` | `[]` | Redirect rules written to the output. Each entry is `{ "from": "/old", "to": "/new", "status": 301 }`. |
| `wait` | `number` | auto | Milliseconds to wait for a page to finish rendering before snapshot. When omitted the renderer waits for a `manifest:render-ready` signal from the data plugin. |
| `concurrency` | `number` | `2` | Number of pages rendered in parallel. Increase for faster builds on high-core machines; decrease if memory is constrained. |
| `retries` | `number` | `2` | Number of retry attempts for pages that fail to render. |
| `browserRecycleEvery` | `number` | `50` | Recycle the browser after this many pages to prevent memory buildup on large sites. |
| `tailwindInput` | `string` | — | Path to a custom Tailwind CSS entry file relative to the project root. Tailwind compilation is otherwise auto-detected via the `data-tailwind` attribute on the manifest script tag. |

---

### Hydration

The prerendering build process makes all HTML/Alpine content static. To preserve dynamic functionality on a specific element, apply the `data-hydrate` attribute. The prerender will restore that element's source code at runtime so Alpine can initialize it normally.

<x-code-group>

```html "Hydrated"
/* Maintains source code & dynamic functionality */
<div x-data="{ counter: 0 }" data-hydrate>
  <button @click="counter++" x-text="counter"></button>
</div>
```

```html "Default/Static"
/* Uses static value from prerendered snapshot */
<div x-data="{ counter: 0 }">
  <button @click="counter++">0</button>
</div>
```

</x-code-group>

Interactive directives like `x-theme`, `x-model`, `@click`, and `:class` are automatically handled by the hydration system and generally do not need `data-hydrate`.

---

### Dynamic Routes

Routes with sub-pages driven by data (e.g. a `<x-docs>` component that resolves articles from a YAML file) need a wildcard `*` to be discovered by the prerender. Use comma-separated conditions to match both the prefix and its children:

```html "index.html" copy
<x-docs x-route="/docs, /docs/*"></x-docs>
```

The renderer will then enumerate every `path:` entry in the matching data source under `/docs/`, producing a static page per article.

---

### Page Transitions

Manifest enables <a href="https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API" target="_blank">cross-document view transitions</a> by default for prerendered MPAs. Page navigations automatically crossfade in supporting browsers, with no JavaScript or author setup required. Browsers without support fall back to a normal navigation.

Tune the default duration and easing via CSS custom properties:

```css copy
:root {
    --view-transition-duration: 200ms;
    --view-transition-easing: cubic-bezier(0.4, 0, 0.2, 1);
}
```

Opt specific elements out of the transition by adding `data-no-view-transition` (or set `view-transition-name: none` in CSS). Live/embedded content like `<iframe>`, `<video>`, and `<canvas>` are excluded by default to prevent flicker mid-transition.

```html copy
<div data-no-view-transition>
    <!-- Excluded from page transition snapshot -->
</div>
```

Authors who want elements to morph between pages (e.g. a hero image shared between list and detail views) can give matching elements the same `view-transition-name`:

```css copy
.hero-image {
    view-transition-name: hero;
}
```

::: brand icon="lucide:info"
Respects `prefers-reduced-motion` automatically through Manifest's existing reduced-motion reset.
:::

---

### Publishing

To deploy an MPA on a host environment, set the root directory to the prerendered output directory (i.e. `./website`).
