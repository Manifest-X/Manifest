# Router

Set page navigation paths in your project.

---

## Overview

With the router plugin, Manifest turns your project into a single-page application (SPA), where URL paths can be used to show or hide any element, including [components](/docs/core-plugins/components).

See [website publishing](/docs/publishing/websites) for generating static sites that are optimized for search engines and AI crawlers, also supported by this router.

::: brand icon="lucide:info"
If applied, this router should be used independent of other routing systems or frameworks with routers.
:::

---

## Setup

The router is included in `manifest.js` with all core plugins, or can be selectively loaded.

<x-code-group copy>

```html "All Plugins (default)"
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"></script>
```

```html "Selective"
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"
    data-plugins="router"></script>
```

</x-code-group>

---

## Routing

`index.html` is the entrypoint for rendering, where high-level elements, layout structures, and components can be applied. Within `index.html` or any component HTML file, use the `x-route` attribute to make any element conditional on a URL path.

<x-code-group>

```html "index.html"
<!DOCTYPE html>
<html>
    <head>
        ...
    </head>
    <body>
        <x-header></x-header>
        <main>

            <!-- Only renders at the base domain -->
            <x-home x-route="/"></x-home>

            <!-- Only renders at the /about route -->
            <h1 x-route="about">About Us</h1>
            <x-about x-route="about"></x-about>

        </main>
        <x-footer></x-footer>
    </body>
</html>
```

```html "home.html"
<div>There's no place like home</div>
```

```html "about.html"
<div>We're all about the Benjamins</div>
```

</x-code-group>

If an element in `index.html` has no `x-route` attribute or value, it will render on all routes. Use `/` for rendering only at the base domain route.

Routing accounts for URL content that does not affect the path:
- **Localization codes**: `/fr/features` matches `features` (after stripping the language code)
- **URL parameters**: `features?filter=active` matches `features` (query parameters are ignored)
- **Anchors**: `features#section` matches `features` (hash fragments are ignored)

---

### Exact Routes

Use `=route` to match only the exact route, excluding any subpaths.

```html
<div x-route="=about">...</div>
```

This is useful when you want to show content only on a specific route without it appearing on subroutes.

---

### Wildcard Routes

A wildcard route can be used to match any route that starts with the given path.

```html
<div x-route="about/*">...</div>
```

This will match any route that has a subpage after `/about/`, such as `/about/location` or `/about/team`. It will not render for `/about` on its own. Conversely, `x-route="about"` will render for `/about` *and* all subpages, since the value always matches one of the slugs.

A bare, top-level wildcard (`x-route="*"`) matches all routes, and is redundant since it's the same as having no `x-route` attribute at all.

---

### Multiple Routes

Multiple comma-separated values allow the element to render if any of the routes match the current route.

```html
<div x-route="/,about,contact">...</div>
```

---

### Omitted Routes

A leading `!` in front of a value will hide the element from that route.

```html
<div x-route="!features,!pricing">...</div>
```

---

### Undefined Routes

Use `!*` to show an element on a route that is not defined by any other `x-route` in the project. This is useful for displaying 404 content if the user goes to a bad link. Note that a bare wildcard `*` appears on all routes, defined or not.

```html
<div x-route="!*">404 page not found</div>
```

When using the prerender script, the 404 view is captured at build time and written to `dist/404.html` so static hosts can serve it for unknown paths.

---

### Other Paths

The router supports non-navigation paths. See [data](/docs/core-plugins/local-data), [localization](/docs/core-plugins/localization), and [URL parameters](/docs/core-plugins/url-parameters) for plugins that apply additional path segments to the URL for content purposes.

---

## Route Magic Property

The router provides a `$route` magic property that returns the current route as a string, enabling conditional statements.

::: frame col
<p>Current logical route: <span class="font-bold" x-text="$route"></span></p>
<p class="font-bold" :class="$route === '/core-plugins/router' ? 'text-brand-content' : ''">I'm a brand color because of the route.</p>
:::

```html copy
<p>Current logical route: <span x-text="$route"></span></p>
<p :class="$route === '/core-plugins/router' ? 'text-brand-content' : ''">I'm a brand color because of the route.</p>
```

---

## Page Head Content

The static content in the `index.html` `<head>` tag is global across all routes. To make head content like the title, metas, scripts, or stylesheets conditional to a specific route, place them in a `<template data-head>` tag, subject to its own route condition or that of a parent's.

<x-code-group>

```html "index.html"
<!DOCTYPE html>
<html>
    <head>
        ...
    </head>
    <body>

        <!-- The script will only append to the head in the base and /about routes -->
        <template data-head x-route="/,about">
            <script>
                console.log('Always use your head');
            </script>
        </template>

        <!-- Special page component -->
        <x-special-page x-route="special"></x-special-page>

    </body>
</html>
```

```html "special-page.html"
<!-- These assets only append to the head if the special page component is rendered -->
<template data-head>
    <title>Special Page</title>
    <link rel="stylesheet" href="/styles/special.css">
    <script src="/scripts/special.js"></script>
</template>

<!-- data-head content can also be nested in a route-specific container -->
 <div x-route="special/*">
    <template data-head>
        <script src="/scripts/even-more.js"></script>
    </template>
</div>

...
```
</x-code-group>

---

## Anchor Navigation

The router follows typical anchor link behaviour with smooth scrolling. Link to any element with an `id` attribute using standard HTML.

```html
<!-- Navigate to an element on the same page -->
<a href="#section">Go to Section</a>

<!-- Target element -->
<h2 id="section">Section Title</h2>
```

It also works for anchors in different routes.

```html
<a href="/about#team">About Our Team</a>
```

The router also handles smooth scrolling to anchors within scrollable containers (not part of the page scroll). A default 100px scroll offset is added for better visibility on landing. Initial page loads with hash fragments are also handled automatically.

---

## Anchor Lists

Use `<template x-anchors="...">` to automatically list anchor links from any elements in your page content, like the "On this page" menu next to this article. Elements can be identified by tag name, class, or an existing ID. If an element does not have an existing ID, the plugin will auto-generate one from its text content, or otherwise apply a random one.

The `x-anchors` directive uses a pipeline syntax to specify the scope and target elements: `scope | targets`.

```html copy
<!-- Generates links from h2 and h3 headings within .prose -->
<template x-anchors=".prose | h2, h3">
  <a :href="anchor.link" x-text="anchor.text"></a>
</template>
```

The plugin auto-expands the template with an `anchor` property:

```html copy
<!-- Manifest automatically adds these attributes -->
<template x-anchors=".prose | h2, h3" x-for="anchor in anchors || []" :key="anchor.id">
  <a :href="anchor.link" x-text="anchor.text"></a>
</template>
```

Multiple scopes and targets can be comma-separated:

```html copy
<!-- Multiple scopes and targets -->
<template x-anchors="#article, .content, main | h1, h2, h3, .card">
  <a :href="anchor.link" 
     class="text-content-subtle hover:text-content-neutral text-sm no-underline" 
     :class="anchor.tag === 'h3' ? 'pl-2' : ''"
     x-text="anchor.text">
  </a>
</template>
```

Omit the scope to scan the entire page for the targets:

```html copy
<!-- Scan entire page for headings -->
<template x-anchors="h1, h2, h3, #title, .card">
  <a :href="anchor.link" x-text="anchor.text"></a>
</template>
```

### Styles

Template tags can only have one child. Use a parent container to arrange the links. Alpine binding can be used to conditionally style anchor links based on their target tag, class, or ID.

```html copy
<template x-anchors=".prose | h2, h3, .callout">
    <div class="col gap-2">
        <a :href="anchor.link" 
            :class="{
                'pl-0': anchor.tag === 'h2',
                'bg-red-100': anchor.class === '.red',
                'opacity-50': anchor.id === '#footnotes'
            }"
            x-text="anchor.text">
        </a>
    </div>
</template>
```