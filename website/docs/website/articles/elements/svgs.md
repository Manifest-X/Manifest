# SVGs

---

## Setup

The SVG plugin is included in `manifest.js` with all core plugins, or can be selectively loaded.

<x-code-group copy>

```html "All Plugins (default)"
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"></script>
```

```html "Selective"
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"
    data-plugins="svg"></script>
```

</x-code-group>

Use `x-svg` to load a local SVG file's `<svg>` element within it. Fetched files are cached in memory for the page session, similar to the [markdown](/docs/core-plugins/markdown) plugin.

---

## File Content

Pass a path to an `.svg` file in the project directory, wrapped in apostrophes.

::: frame
<div class="size-10" x-svg="'/assets/examples/icon-star.svg'"></div>
:::

```html copy
<div class="size-10" x-svg="'/assets/examples/icon-star.svg'"></div>
```

---

## Inline Content

The SVG tag itself can be applied within apostrophes, using `&quot;` for its internal double quotes. However this is redundant when the SVG is easier placed directly as inline HTML.

::: frame
<div class="size-10" x-svg="'<svg xmlns=&quot;http://www.w3.org/2000/svg&quot; viewBox=&quot;0 0 24 24&quot; fill=&quot;currentColor&quot;><path d=&quot;M12 2l2.91 6.41L22 9.27l-5 4.87L18.18 22 12 18.77 5.82 22 7 14.14 2 9.27l7.09-.86z&quot;/></svg>'"></div>
:::

```html copy
<div class="size-10" x-svg="'<svg xmlns=&quot;http://www.w3.org/2000/svg&quot; viewBox=&quot;0 0 24 24&quot; fill=&quot;currentColor&quot;><path d=&quot;M12 2l2.91 6.41L22 9.27l-5 4.87L18.18 22 12 18.77 5.82 22 7 14.14 2 9.27l7.09-.86z&quot;/></svg>'"></div>
```

---

## Dynamic Content

Alpine expressions can supply the SVG string or path at runtime (including template literals), same as [dynamic markdown](/docs/core-plugins/markdown#dynamic-content).

::: frame
<div class="size-10" x-data="{ star: '<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'currentColor\'><path d=\'M12 2l2.91 6.41L22 9.27l-5 4.87L18.18 22 12 18.77 5.82 22 7 14.14 2 9.27l7.09-.86z\'/></svg>' }">
    <span class="block size-full" x-svg="star"></span>
</div>
:::

```html copy
<div class="size-10" x-data="{ star: '<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'currentColor\'><path d=\'M12 2l2.91 6.41L22 9.27l-5 4.87L18.18 22 12 18.77 5.82 22 7 14.14 2 9.27l7.09-.86z\'/></svg>' }">
    <span class="block size-full" x-svg="star"></span>
</div>
```

---

## From Data Sources

The SVG file's path can also be populated from a [data source](/docs/core-plugins/local-data).

::: frame
<span class="size-10 block" x-svg="$x.example.sampleSvg"></span>
:::

<x-code-group copy>

```html "HTML"
<span class="size-10" x-svg="$x.example.sampleSvg"></span>
```

```json "example.json"
{
    "sampleSvg": "/assets/examples/icon-star.svg"
}
```

</x-code-group>

---

## Styles

Modify an SVG's appearance either within the SVG file itself, or using CSS on the **host** or an ancestor. Removing fixed `width` and `height` on the root `<svg>` (keeping `viewBox`) lets utilities or layout on the parent control size. Use `fill="currentColor"` or `stroke="currentColor"` so `color` on the wrapper flows into the graphic.

::: frame
<style>
    .parent svg {
    width: 100%;
    height: 100%;
    background: var(--color-brand-surface)
}
</style>
<div class="size-12 text-brand-content parent" x-svg="'/assets/examples/icon-star.svg'"></div>
:::

<x-code-group copy>

```html "HTML"
<div class="size-12 text-brand-content parent" x-svg="'/assets/examples/icon-star.svg'"></div>
```

```svg "icon-star.svg"
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M12 2l2.91 6.41L22 9.27l-5 4.87L18.18 22 12 18.77 5.82 22 7 14.14 2 9.27l7.09-.86z"/>
</svg>
```

```css "CSS"
.parent svg {
    width: 100%;
    height: 100%;
    background: var(--color-brand-surface)
}
```

</x-code-group>
