# Charts

Reactive SVG charts, from simple sparklines to live dashboards.

---

## Setup

Chart styles are included in Manifest CSS or a standalone stylesheet, both referencing [theme](/docs/styles/theme) variables.

Chart functionality is included in `manifest.js` with all core plugins, or it can be selectively loaded.

<div x-code-group copy>

```html "Manifest CSS / JS"
<!-- Manifest CSS -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.css" />

<!-- Manifest JS -->
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"></script>
```

```html "Standalone"
<!-- Chart styles only, with tooltip dependency -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.chart.css" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.tooltip.css" />

<!-- Manifest JS: charts plugin only -->
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"
  data-plugins="charts"></script>
```

</div>

::: brand icon="lucide:info"
Charts render as SVG, so they inherit theme colors, restyle with ordinary CSS, and survive [prerendering](/docs/publishing/websites) as real DOM. The geometry engine (d3's scale/shape micro-modules, ~22 KB) lazy-loads the first time a chart scrolls into view. Pages that never show a chart never pay for one.
:::

---

## Chart Types

Declare a chart by passing a config object to `x-chart` on any container. The `type` selects the renderer; everything else is shared.

### Line

<div x-code-group>

```html copy
<div x-chart="{
    type: 'line',
    labels: ['Jan','Feb','Mar','Apr','May','Jun'],
    series: [{ name: 'Visitors', data: [30, 80, 45, 90, 60, 120] }],
    height: 200
}"></div>
```

::: frame
<div x-chart="{ type: 'line', labels: ['Jan','Feb','Mar','Apr','May','Jun'], series: [{ name: 'Visitors', data: [30, 80, 45, 90, 60, 120] }], height: 200 }" style="max-width: 420px;"></div>
:::

</div>

Lines interpolate smoothly by default. Set `curve` to change it: `'linear'` for straight segments, `'step'` for tiers, `'natural'` for splines.

<div x-code-group>

```html copy
<div x-chart="{ type: 'line', curve: 'step', ... }"></div>
```

::: frame
<div x-chart="{ type: 'line', curve: 'step', labels: ['Jan','Feb','Mar','Apr','May','Jun'], series: [{ name: 'Tier', data: [1, 1, 2, 2, 3, 3] }], height: 180 }" style="max-width: 420px;"></div>
:::

</div>

### Area

Area charts are line charts with a translucent fill. Add `stacked: true` to pile series on top of each other.

<div x-code-group>

```html copy
<div x-chart="{
    type: 'area',
    stacked: true,
    labels: ['Q1','Q2','Q3','Q4'],
    series: [
        { name: 'Organic', data: [40, 55, 60, 80] },
        { name: 'Paid', data: [20, 30, 25, 45] }
    ],
    height: 200
}"></div>
```

::: frame
<div x-chart="{ type: 'area', stacked: true, labels: ['Q1','Q2','Q3','Q4'], series: [{ name: 'Organic', data: [40, 55, 60, 80] }, { name: 'Paid', data: [20, 30, 25, 45] }], height: 200 }" style="max-width: 420px;"></div>
:::

</div>

### Bar

Multiple series render as grouped bars; `stacked: true` stacks them instead.

<div x-code-group>

```html copy
<div x-chart="{
    type: 'bar',
    stacked: true,
    dataLabels: true,
    labels: ['Jan','Feb','Mar'],
    series: [
        { name: 'Revenue', data: [120, 200, 150] },
        { name: 'Costs', data: [80, 110, 95] }
    ],
    height: 200
}"></div>
```

::: frame
<div x-chart="{ type: 'bar', stacked: true, dataLabels: true, labels: ['Jan','Feb','Mar'], series: [{ name: 'Revenue', data: [120, 200, 150] }, { name: 'Costs', data: [80, 110, 95] }], height: 200 }" style="max-width: 420px;"></div>
:::

</div>

### Pie & Donut

Pie charts take a single series whose values become slices, colored from the theme palette in order. `type: 'donut'` hollows the center. Data also accepts `[{ label, value }]` rows.

<div x-code-group>

```html copy
<div x-chart="{
    type: 'donut',
    labels: ['Mobile','Desktop','Tablet'],
    series: [{ data: [55, 35, 10] }],
    height: 220
}"></div>
```

::: frame row-wrap gap-10
<div x-chart="{ type: 'pie', dataLabels: true, labels: ['Direct','Search','Social','Referral'], series: [{ data: [38, 27, 21, 14] }], height: 220 }" style="max-width: 300px;"></div>
<div x-chart="{ type: 'donut', labels: ['Mobile','Desktop','Tablet'], series: [{ data: [55, 35, 10] }], height: 220 }" style="max-width: 300px;"></div>
:::

</div>

### Scatter

<div x-code-group>

```html copy
<div x-chart="{
    type: 'scatter',
    labels: [1,2,3,4,5,6,7,8],
    series: [{ name: 'Sample', data: [12, 30, 18, 44, 25, 50, 33, 60] }],
    height: 200
}"></div>
```

::: frame
<div x-chart="{ type: 'scatter', labels: [1,2,3,4,5,6,7,8], series: [{ name: 'Sample', data: [12, 30, 18, 44, 25, 50, 33, 60] }], height: 200 }" style="max-width: 420px;"></div>
:::

</div>

### Combo

`type: 'combo'` mixes renderers in one plot — give each series its own `type` (`bar`, `line`, or `area`). Series without one default to bars.

<div x-code-group>

```html copy
<div x-chart="{
    type: 'combo',
    labels: ['Jan','Feb','Mar','Apr','May','Jun'],
    series: [
        { name: 'Revenue', type: 'bar', data: [120, 200, 150, 280, 230, 320] },
        { name: 'Margin %', type: 'line', data: [20, 35, 28, 44, 40, 52] }
    ],
    height: 200
}"></div>
```

::: frame
<div x-chart="{ type: 'combo', labels: ['Jan','Feb','Mar','Apr','May','Jun'], series: [{ name: 'Revenue', type: 'bar', data: [120, 200, 150, 280, 230, 320] }, { name: 'Margin %', type: 'line', data: [20, 35, 28, 44, 40, 52] }], height: 200 }" style="max-width: 420px;"></div>
:::

</div>

### Candlestick

`type: 'candlestick'` (or `'ohlc'`) plots open–high–low–close rows, as `{ o, h, l, c }` objects (long names `open`/`high`/`low`/`close` also work) or `[o, h, l, c]` arrays. Rising candles use the theme's positive color, falling ones the negative.

<div x-code-group>

```html copy
<div x-chart="{
    type: 'candlestick',
    labels: ['Mon','Tue','Wed','Thu','Fri'],
    series: [{ data: [
        { o: 30, h: 38, l: 28, c: 36 },
        { o: 36, h: 40, l: 33, c: 34 },
        { o: 34, h: 35, l: 26, c: 28 },
        { o: 28, h: 33, l: 27, c: 32 },
        { o: 32, h: 44, l: 31, c: 42 }
    ] }],
    height: 200
}"></div>
```

::: frame
<div x-chart="{ type: 'candlestick', labels: ['Mon','Tue','Wed','Thu','Fri'], series: [{ data: [ { o: 30, h: 38, l: 28, c: 36 }, { o: 36, h: 40, l: 33, c: 34 }, { o: 34, h: 35, l: 26, c: 28 }, { o: 28, h: 33, l: 27, c: 32 }, { o: 32, h: 44, l: 31, c: 42 } ] }], height: 200 }" style="max-width: 420px;"></div>
:::

</div>

---

## Configuration

| Key          | Type             | Description                                                                  |
| ------------ | ---------------- | ---------------------------------------------------------------------------- |
| `type`{copy}       | string           | `line`, `area`, `bar`, `pie`, `donut`, `scatter`, `combo`, `candlestick`. Default `line`. |
| `labels`{copy}     | array            | X-axis categories (or slice labels).                                          |
| `series`{copy}     | array            | `{ name, data, color?, type? }` per series. `color` overrides the palette; `type` applies in combo charts. |
| `data`{copy}       | array            | Shorthand for a single unnamed series.                                        |
| `height`{copy}     | number           | Chart height in pixels. Default `240`. Width tracks the container.            |
| `stacked`{copy}    | boolean          | Stack bar/area series. Default `false`.                                       |
| `curve`{copy}      | string           | Line interpolation — `monotone` (default), `linear`, `step`, `natural`.       |
| `legend`{copy}     | boolean          | Show the legend (multi-series and pies). Default `true`.                      |
| `axis`{copy} / `grid`{copy} | boolean | Show axis labels / grid lines. Default `true`.                                |
| `tooltip`{copy}    | boolean          | Hover tooltips on segments. Default `true`.                                   |
| `dataLabels`{copy} | boolean          | Static value labels on points, bars, and slices. Default `false`.             |
| `title`{copy}      | string           | Accessible chart label (`aria-label` on the SVG).                             |

### Declarative Series

For content-first authoring, set the type as a modifier and declare each series as a `<data>` child — handy when values come from [local data](/docs/core-plugins/local-data) bindings.

```html copy
<figure x-chart.bar labels="['Q1','Q2','Q3','Q4']">
    <data series="Revenue" :values="$x.finance.revenue"></data>
    <data series="Costs" :values="$x.finance.costs" color="#f43f5e"></data>
</figure>
```

---

## Dynamic Data

The config is a live Alpine expression: charts re-render whenever the data behind them changes. Bind series to [local data](/docs/core-plugins/local-data), [cloud data](/docs/appwrite-plugins/cloud-data), or any reactive state — dashboards assemble themselves from whatever `$x` holds.

```html copy
<!-- Re-draws whenever $x.sales loads or updates -->
<div x-chart="{
    type: 'bar',
    labels: $x.sales.labels,
    series: $x.sales.series,
    height: 240
}"></div>
```

Charts also re-render automatically on container resize and on locale switch (axis numbers use the active locale's compact notation).

### Magic Method

Use `$chart(id)` to read or update a chart programmatically.

| Member                    | Description                                          |
| ------------------------- | ----------------------------------------------------- |
| `$chart(id).type`{copy}         | The active chart type.                                |
| `$chart(id).series`{copy}       | The normalized series array.                          |
| `$chart(id).update(cfg)`{copy}  | Replace the config and redraw.                        |
| `$chart(id).redraw()`{copy}     | Force a redraw with the current config.               |

```html copy
<div id="sales" x-chart="{ type: 'bar', ... }"></div>
<button @click="$chart('sales').update({ type: 'line', labels: [...], series: [...] })">
    As line
</button>
```

---

## Styles

### Theme

Series cycle through the `--color-chart-N` color variable palette in order. By default there are nine colors, segment 10 wraps back to `--color-chart-1`. The palette size is read from CSS; define `--color-chart-10`, `--color-chart-11`, … in your theme (globally or scoped to one chart) and the cycle extends automatically.

| Variable               | Purpose                                       |
| ---------------------- | ---------------------------------------------- |
| `--color-chart-1`{copy} … `--color-chart-8`{copy} | Series palette, applied in order. |
| `--color-chart-grid`{copy}   | Grid line color.                              |
| `--color-chart-label`{copy}  | Axis label color.                             |
| `--color-positive-content`{copy} / `--color-negative-content`{copy} | Rising / falling candlesticks. |

```css copy
/* Extend the palette past 9 */
:root {
    --color-chart-10: oklch(60% 0.13 250);
    --color-chart-11: oklch(65% 0.15 320);
}

/* Rebrand one chart's palette */
#sales {
    --color-chart-1: var(--color-brand-content);
}
```

Per-series overrides also work inline through the config (`series: [{ color: '#f43f5e', ... }]`), which beats the palette.

---

### Tailwind CSS

Charts size to their container, so layout is ordinary utility work.

```html copy
<div class="grid md:grid-cols-3 gap-8">
    <div x-chart="{ type: 'line', ... }"></div>
    <div x-chart="{ type: 'bar', ... }"></div>
    <div x-chart="{ type: 'donut', ... }"></div>
</div>
```

---

### Customization

Modify base styles with custom CSS targeting `[x-chart]` (or the `.chart` marker class the plugin stamps on every chart, which also covers modified directives like `x-chart.bar`). The SVG output uses plain element selectors:

| Selector              | Part                                          |
| --------------------- | --------------------------------------------- |
| `svg line`{copy}            | Grid lines (and candle wicks within their group) |
| `svg text`{copy}            | Axis labels                                   |
| `path.line`{copy}           | Line series strokes                           |
| `path.area`{copy}           | Area fills                                    |
| `path.slice`{copy}          | Pie / donut slices                            |
| `rect`{copy}                | Bars and candle bodies                        |
| `circle`{copy}              | Line points and scatter dots (`.scatter`)     |
| `g.positive`{copy} / `g.negative`{copy} | Rising / falling candles          |
| `text.value`{copy}          | Data labels (`.inverse` when on a filled segment) |
| `footer`{copy}              | Legend — `<span>` items with `<i>` swatches   |
| `.tooltip`{copy}            | Cursor tooltip — chrome shared with [tooltips](/docs/elements/tooltips) |

Each series element carries its resolved color as `--color-chart-color`, so one rule can restyle any series-colored part.

```css copy
/* Thicker lines and bigger points */
.chart path.line {
    stroke-width: 3;
}

.chart circle {
    r: 4;
}

/* Square legend swatches into dots */
.chart footer i {
    border-radius: 50%;
}
```
