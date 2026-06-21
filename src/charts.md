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

Area charts are line charts with a translucent fill. Add `stacked: true`{copy} to pile series on top of each other.

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

Multiple series render as grouped bars; `stacked: true`{copy} stacks them instead.

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

Pie charts take a single series whose values become slices, colored from the theme palette in order. `type: 'donut'`{copy} hollows the center. Data also accepts `[{ label, value }]`{copy} rows.

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

`type: 'combo'`{copy} mixes renderers in one plot — give each series its own `type` (`bar`, `line`, or `area`). Series without one default to bars.

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

`type: 'candlestick'`{copy} (or `'ohlc'`) plots open–high–low–close rows, as `{ o, h, l, c }`{copy} objects (long names `open`/`high`/`low`/`close` also work) or `[o, h, l, c]`{copy} arrays. Rising candles use the theme's positive color, falling ones the negative.

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

### Gauge

`type: 'gauge'`{copy} plots a single value on a 180° dial — a compact KPI readout. Give it a `value` (or a one-number `series`/`data`); `unit` suffixes the centered readout.

<div x-code-group>

```html copy
<div x-chart="{ type: 'gauge', value: 73, unit: '%', height: 180 }"></div>
```

::: frame row-wrap gap-10
<div x-chart="{ type: 'gauge', value: 73, unit: '%', height: 180 }" style="max-width: 280px;"></div>
:::

</div>

The dial runs 0–100 by default. Set `min: <n>`{copy} and `max: <n>`{copy} to rescale it — the end labels and the value fill follow the new range.

<div x-code-group>

```html copy
<div x-chart="{ type: 'gauge', value: 6.2, min: 0, max: 10, height: 180 }"></div>
```

::: frame row-wrap gap-10
<div x-chart="{ type: 'gauge', value: 6.2, min: 0, max: 10, height: 180 }" style="max-width: 280px;"></div>
:::

</div>

Pass `zones`{copy} to paint threshold bands behind the value arc — an array of `{ to, color }`{copy} segments, each running from the previous `to` (or `min`) up to its own. Useful for good/warning/critical ranges.

<div x-code-group>

```html copy
<div x-chart="{
    type: 'gauge',
    value: 88,
    unit: '%',
    zones: [
        { to: 50, color: 'var(--color-negative-content)' },
        { to: 80, color: 'var(--color-brand-content)' },
        { to: 100, color: 'var(--color-positive-content)' }
    ],
    height: 180
}"></div>
```

::: frame row-wrap gap-10
<div x-chart="{ type: 'gauge', value: 88, unit: '%', height: 180, zones: [ { to: 50, color: 'var(--color-negative-content)' }, { to: 80, color: 'var(--color-brand-content)' }, { to: 100, color: 'var(--color-positive-content)' } ] }" style="max-width: 280px;"></div>
:::

</div>

### Heatmap

`type: 'heatmap'`{copy} renders a matrix of tiles — each series is a **row**, each datum a **column** aligned to `labels`, and the series `name` is the row label. Tile color interpolates across the value range using the heatmap ramp (see [Theme](#theme)).

<div x-code-group>

```html copy
<div x-chart="{
    type: 'heatmap',
    labels: ['12a','4a','8a','12p','4p','8p'],
    series: [
        { name: 'Mon', data: [2, 1, 8, 14, 18, 9] },
        { name: 'Tue', data: [3, 1, 10, 16, 20, 11] },
        { name: 'Wed', data: [1, 0, 7, 13, 22, 14] }
    ],
    height: 200
}"></div>
```

::: frame
<div x-chart="{ type: 'heatmap', labels: ['12a','4a','8a','12p','4p','8p'], series: [ { name: 'Mon', data: [2, 1, 8, 14, 18, 9] }, { name: 'Tue', data: [3, 1, 10, 16, 20, 11] }, { name: 'Wed', data: [1, 0, 7, 13, 22, 14] }, { name: 'Thu', data: [4, 2, 12, 19, 25, 16] }, { name: 'Fri', data: [5, 3, 14, 21, 28, 24] } ], height: 220 }" style="max-width: 460px;"></div>
:::

</div>

Set `dataLabels: true`{copy} to print each value in its tile, and `gap` to change the tile gutter (px, default `1`; use `0` for a seamless field).

<div x-code-group>

```html copy
<div x-chart="{ type: 'heatmap', dataLabels: true, gap: 0, ... }"></div>
```

::: frame row-wrap gap-10
<div x-chart="{ type: 'heatmap', dataLabels: true, labels: ['Q1','Q2','Q3','Q4'], series: [ { name: 'North', data: [12, 19, 24, 31] }, { name: 'South', data: [8, 14, 11, 22] }, { name: 'West', data: [20, 25, 28, 40] } ], height: 180 }" style="max-width: 460px;"></div>
:::

</div>

---

## Configuration

| Key          | Type             | Description                                                                  |
| ------------ | ---------------- | ---------------------------------------------------------------------------- |
| `type`{copy}       | string           | `line`, `area`, `bar`, `pie`, `donut`, `scatter`, `combo`, `candlestick`, `gauge`, `heatmap`. Default `line`. |
| `labels`{copy}     | array            | X-axis categories, slice labels, or heatmap columns.                          |
| `series`{copy}     | array            | `{ name, data, color?, type? }` per series. `color` overrides the palette; `type` applies in combo charts; in a heatmap each series is a row and `name` is its label. |
| `data`{copy}       | array            | Shorthand for a single unnamed series.                                        |
| `height`{copy}     | number           | Chart height in pixels. Default `240`. Width tracks the container.            |
| `stacked`{copy}    | boolean          | Stack bar/area series. Default `false`.                                       |
| `curve`{copy}      | string           | Line interpolation — `monotone` (default), `linear`, `step`, `natural`.       |
| `legend`{copy}     | boolean          | Show the legend (multi-series, pies, heatmap ramp). Default `true`.           |
| `axis`{copy} / `grid`{copy} | boolean | Show axis labels / grid lines (heatmap: row & column labels). Default `true`. |
| `tooltip`{copy}    | boolean          | Hover tooltips on segments. Default `true`.                                   |
| `dataLabels`{copy} | boolean          | Static value labels on points, bars, slices, and heatmap tiles. Default `false`. |
| `title`{copy}      | string           | Accessible chart label (`aria-label` on the SVG).                             |
| `value`{copy}      | number           | Gauge — the plotted value (or use a one-number `series`/`data`).              |
| `min`{copy} / `max`{copy} | number    | Gauge range. Default `0` / `100`.                                             |
| `unit`{copy}       | string           | Gauge — suffix on the centered readout (e.g. `'%'`).                          |
| `zones`{copy}      | array            | Gauge — threshold bands: `{ to, color }` segments behind the value arc.       |
| `gap`{copy}        | number           | Heatmap — tile gutter in px. Default `1`; `0` for a seamless field.           |

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
| `--color-chart-heat-low`{copy} / `--color-chart-heat-high`{copy} | Heatmap ramp endpoints (low → high value). |

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

Per-series overrides also work inline through the config (`series: [{ color: '#f43f5e', ... }]`{copy}), which beats the palette.

The heatmap ramp is a single-hue sequential scale derived from `--color-chart-1` by default. Override the two endpoints to recolor it — the tiles interpolate between them with `color-mix`:

```css copy
:root {
    --color-chart-heat-low: var(--color-surface-2);
    --color-chart-heat-high: var(--color-brand-content);
}
```

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
| `rect.heat-cell`{copy}      | Heatmap tiles (fill driven by the `--heat` percentage) |
| `circle`{copy}              | Line points and scatter dots (`.scatter`)     |
| `g.positive`{copy} / `g.negative`{copy} | Rising / falling candles          |
| `path.gauge-track`{copy} / `path.gauge-value`{copy} | Gauge track and value arc         |
| `text.value`{copy}          | Data labels (`.inverse` when on a filled segment) |
| `text.gauge-label`{copy}    | Gauge centered readout                        |
| `footer`{copy}              | Legend — `<span>` items with `<i>` swatches (heatmap: `footer.heat-legend` gradient bar) |
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
