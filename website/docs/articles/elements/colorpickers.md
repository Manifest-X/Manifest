# Color Pickers

---

## Setup

Color picker styles are included in Manifest CSS or a standalone stylesheet, both referencing [theme](/docs/styles/theme) variables.

Color picker functionality is included in `manifest.js` with all core plugins, or it can be selectively loaded.

<x-code-group copy>

```html "Manifest CSS / JS"
<!-- Manifest CSS -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.css" />

<!-- Manifest JS -->
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"></script>
```

```html "Standalone"
<!-- Color picker styles only, with dropdown and tooltip dependencies -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.colorpicker.min.css" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.dropdown.min.css" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.tooltip.min.css" />

<!-- Manifest JS: color picker plugin only, with dropdown and tooltip dependencies -->
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"
  data-plugin="colorpicker,dropdown,tooltip"></script>
```

</x-code-group>

::: brand icon="lucide:info"
The default color picker menu uses [dropdowns](/docs/elements/dropdowns) and [tooltips](/docs/elements/tooltips), with their respective plugins and styles as dependencies.
:::

---

## Swatch

Every color picker starts with a clickable preview of the current color, called a swatch.

### Native Input

The simplest swatch is a native `<input type="color">`, displaying the browser's built-in picker menu when pressed.

::: frame
<input type="color" value="#3b82f6">
:::

```html copy
<input type="color" value="#3b82f6">
```

---

### Picker Button

Manifest provides a more nuanced color picker menu, opened by default as a [dropdown](/docs/elements/dropdowns) from a button swatch with `x-colorpicker.swatch`.

::: frame
<button x-colorpicker.swatch></button>
:::

```html copy
<button x-colorpicker.swatch></button>
```

#### Default Color

Set a default color with the swatch's `value` attribute — the same attribute a native `<input type="color">` would carry. The value seeds the picker's initial state and the swatch's preview before any user interaction. Any valid CSS color or gradient is accepted.

::: frame
<button x-colorpicker.swatch value="#ff0000"></button>
:::

```html copy
<button x-colorpicker.swatch value="#ff0000"></button>
```

For two-way reactive binding, use `x-model` instead. When both are present, `x-model` wins.

```html copy
<button x-colorpicker.swatch x-model="color" x-data="{ color: '#ff0000' }"></button>
```

#### Form Participation

Add a `name` attribute to make a swatch submit with a `<form>`, just like any other form field. The plugin synthesizes a paired hidden input with that name and keeps it in sync with the picker's current color.

```html copy
<form>
    <button x-colorpicker.swatch name="background" value="#3b82f6"></button>
    <button type="submit">Save</button>
</form>
```

---

### Applying Color

To use a picker's value elsewhere, read it with the `$colorpicker(id)` magic method.

::: frame
<button id="brand" x-colorpicker.swatch></button>

<span class="h1" :style="`color: ${$colorpicker('brand')}`">Brand Color</span>
<span x-text="${$colorpicker('brand')"></span>
:::

```html copy
<button id="brand" x-colorpicker.swatch></button>

<h1 :style="`color: ${$colorpicker('brand')}`">Brand Color</h1>
<span x-text="${$colorpicker('brand')"></span>
```

---

## Menu

The color picker menu offers solid and gradient editing, four color spaces with alpha (Hex, RGB, HSL, OKLCH), custom and recent palettes, and a screen eyedropper. Manifest resolves a swatch's menu in this order:

1. **Inline picker** — a live element on the page whose `id` matches the swatch's value.
2. **Default template** — a single `<template x-colorpicker>` (see [Default Override](#default-override)).
3. **Plugin fallback** — used when neither of the above exists.

The wrapper element of an inline picker determines its presentation: `<menu popover>` anchors to the swatch as a dropdown, `<dialog popover>` opens centered as a modal, and `<div>` renders in the page flow.

::: frame
<button x-colorpicker.swatch="dropdown-picker"></button>
<button x-colorpicker.swatch="dialog-picker"></button>
<button x-colorpicker.swatch="inline-picker"></button>
<menu id="dropdown-picker" popover x-colorpicker></menu>
<dialog id="dialog-picker" popover x-colorpicker></dialog>
<div id="inline-picker" x-colorpicker></div>
:::

```html copy
<!-- Dropdown -->
<button x-colorpicker.swatch="dropdown-picker"></button>
<menu id="dropdown-picker" popover x-colorpicker></menu>

<!-- Dialog -->
<button x-colorpicker.swatch="dialog-picker"></button>
<dialog id="dialog-picker" popover x-colorpicker></dialog>

<!-- Inline -->
<button x-colorpicker.swatch="inline-picker"></button>
<div id="inline-picker" x-colorpicker></div>
```

A picker with no children renders the plugin's fallback UI. Add child directives like `x-colorpicker.solid` to customize specific panels (see [Panels](#panels)).

---

### Panels

By default, the picker menu shows three tabs: Solid, Gradient, and Library. You can hide tabs you don't need, change their order, or replace the entire menu with custom HTML.

Limit which panels appear by passing them as a value in a bare swatch or a modified `x-colorpicker` attribute in a picker menu.

```html "Bare swatches" copy
<!-- Solids only -->
<button x-colorpicker.swatch="['solid']"></button>

<!-- Solids and gradients, no library -->
<button x-colorpicker.swatch="['solid', 'gradient']"></button>

<!-- Library first -->
<button x-colorpicker.swatch="['library', 'solid', 'gradient']"></button>
```

```html "Modified picker menus" copy
<button x-colorpicker.swatch="my-picker"></button>

<!-- Modified menu -->
<menu id="my-picker" popover x-colorpicker>
    <div x-colorpicker.solid></div>
    <div x-colorpicker.library></div>
</menu>
```

When only one panel is allowed, the tab bar is hidden automatically.

### Default Override

To replace the fallback menu page-wide, declare a single `<template x-colorpicker>` (no `id`, no value) anywhere in your markup. Every bare swatch on the page that would otherwise auto-create the plugin's default menu instead clones from your template — preserving its wrapper element (`<menu>`, `<dialog>`, or `<div>`) and any attributes you put on it.

```html copy
<!-- Page-wide default -->
<template x-colorpicker>
    <menu popover>
        <!-- Your custom picker UI: tabs, panels, directives -->
    </menu>
</template>

<!-- Every bare swatch on the page now uses your template -->
<button x-colorpicker.swatch></button>
<button x-colorpicker.swatch></button>
```

To componentize the default across multiple pages or routes, wrap the template in a Manifest [HTML component](/docs/elements/components) and drop it into your layout.

::: brand icon="lucide:info"
Inline pickers (`<menu id="X" popover x-colorpicker>`) and panel-filtering on swatches (`x-colorpicker.swatch="['solid']"`) always take precedence over the page default — the default fills in only for bare swatches with no other source.
:::
```

See the source of `manifest.colorpicker.js` for the full set of available directives if you're authoring a custom menu.

---

## Solids

The Solid panel offers a 2D saturation/lightness canvas, a hue slider, an alpha slider, a format selector (`HEX`, `RGB`, `HSL`, `OKLCH`), and direct value inputs.

::: frame
<button x-colorpicker="['solid']" class="size-8 rounded-md ring-1 ring-black/10"></button>
:::

The current solid color is exposed at `$colorpicker(id).hex` and `$colorpicker(id).css`. Format toggling does not change the underlying value — only the visual representation in the inputs.

---

## Gradients

The Gradient panel supports linear, radial, and conic gradients with arbitrary numbers of layers and stops.

::: frame
<button x-colorpicker="['gradient']" class="size-8 rounded-md ring-1 ring-black/10"></button>
:::

Each gradient has one or more **layers**, and each layer has two or more **stops**. The plugin exposes the following scope variables inside the gradient panel template, which custom menus can read:

| Variable      | Description                                  |
| ------------- | -------------------------------------------- |
| `layerType`   | `'linear'`, `'radial'`, or `'conic'`         |
| `layerIndex`  | Zero-based index of the active layer         |
| `layerCount`  | Total number of layers                       |

Layer-management directives (used by the default menu, available to custom menus):

| Directive             | Action                                          |
| --------------------- | ----------------------------------------------- |
| `set-gradient-type`   | Switch the active layer to `linear`/`radial`/`conic` |
| `rotate-layer`        | Rotate the active layer's angle                 |
| `flip-layer`          | Reverse the stop order                          |
| `add-layer-above`     | Insert a new layer above the active one         |
| `add-layer-below`     | Insert a new layer below                        |
| `duplicate-layer`     | Clone the active layer                          |
| `move-layer-up`       | Reorder the active layer up the stack           |
| `move-layer-down`     | Reorder the active layer down the stack         |
| `remove-layer`        | Delete the active layer (disabled if only one) |

Stops support **right-click context menus** for duplication and deletion, and dragging to reposition along the gradient.

The full gradient as a CSS string is available at `$colorpicker(id).css`, ready to drop into `background:` or `background-image:`.

---

## Library

The Library panel is where preset palettes live. There are three sources, each shown as its own group.

### Recent Palette

The plugin tracks the most recently committed colors per swatch and surfaces them at the top of the Library panel. Selecting a swatch from Recent restores both solid colors and full gradients exactly as they were committed.

A color enters Recent only when the picker menu closes — adjusting the canvas does not pollute the list.

::: brand icon="lucide:info"
Recent is per-swatch and persists in `localStorage`. To clear it programmatically, see [State & Magic Methods](#state-magic-methods).
:::

### Default Palettes

Two default palettes are bundled: **Tailwind** (the full Tailwind CSS color scale) and **iOS** (Apple's system colors). Both appear in the Library panel automatically.

To override either palette with your own colors, define `_tailwind` or `_ios` in your colorpicker data file (see [Custom Palettes](#custom-palettes) below for the file location and shape). To **opt out** of a default palette entirely, assign it an empty object:

```yaml
_tailwind: {}
_ios: {}
```

Either palette can be replaced or hidden independently — opting out of Tailwind does not affect iOS, and vice versa.

### Custom Palettes

To add your own palettes, point the manifest's `colorpicker` key at a data source — typically a YAML file in `data/`.

**`manifest.json`**

```json copy
{
    "data": {
        "brand-colors": "/data/brand-colors.yaml"
    },
    "colorpicker": "brand-colors"
}
```

**`data/brand-colors.yaml`**

```yaml copy
Primary:
    _name: Primary Brand
    blue: "#3b82f6"
    indigo: "#6366f1"
    violet: "#8b5cf6"

Accent:
    _name: Accents
    rose: "#f43f5e"
    amber: "#f59e0b"
    emerald: "#10b981"
```

Top-level keys become palette groups. Each group is a flat map of `name: color`. The reserved `_name` key sets the displayed group label (otherwise the key itself is used). Colors can be any valid CSS color string — including gradients.

You can ship multiple palettes — every top-level group becomes its own collapsible section in the Library panel, in the order you define them.

---

## Localization

Color picker strings — palette names, group labels, tab titles, tooltips on layer/stop actions, the eyedropper button — can all be translated by providing a per-locale data source.

In `manifest.json`, replace the single colorpicker file with a locale map:

```json copy
{
    "data": {
        "brand-colors": {
            "en": "/data/brand-colors.en.yaml",
            "fr": "/data/brand-colors.fr.yaml"
        }
    },
    "colorpicker": "brand-colors"
}
```

The plugin reads from the file matching the active locale (set via the [Localization plugin](/docs/core-plugins/localization)).

In addition to your custom palettes, each locale file can define a reserved `_ui` block to translate the picker's built-in strings:

```yaml copy
_ui:
    tabs:
        solid: Solid
        gradient: Gradient
        library: Library
    grabColor: Grab color from screen
    gradientTypes:
        linear: Linear
        radial: Radial
        conic: Conic
    layerActions:
        rotate: Rotate
        flip: Flip
        addAbove: Add layer above
        addBelow: Add layer below
        duplicate: Duplicate
        moveUp: Move up
        moveDown: Move down
        remove: Remove layer
    stopActions:
        duplicate: Duplicate stop
        delete: Delete stop
    recent:
        remove: Remove from recent

# Palettes
Primary:
    _name: Primary
    blue: "#3b82f6"
```

Any string you omit from `_ui` falls back to the plugin's English default, so partial translations are safe.

::: brand icon="lucide:info"
For palette **color names** (the labels under each swatch), translation works the same way — define the same color keys in each locale file with translated labels.
:::

---

## Grab Color

The Solid panel includes an eyedropper button that activates the browser's [`EyeDropper API`](https://developer.mozilla.org/docs/Web/API/EyeDropper) to sample any pixel on screen. The button is shown automatically in browsers that support it and hidden everywhere else.

No configuration is required. The sampled color is set as the picker's current color and committed to Recent on close.

---

## State & Magic Methods

The `$colorpicker(id)` magic method returns a reactive object describing the picker with that `id`.

| Property      | Type      | Description                                            |
| ------------- | --------- | ------------------------------------------------------ |
| `.hex`        | `string`  | Current solid color as hex (e.g. `'#3b82f6'`)          |
| `.css`        | `string`  | Ready-to-use CSS color or gradient string              |
| `.formatted`  | `string`  | Current value in the active format (HEX/RGB/HSL/OKLCH) |
| `.mode`       | `string`  | `'solid'` or `'gradient'`                              |
| `.layers`     | `array`   | Gradient layer descriptors (when `mode === 'gradient'`)|
| `.format`     | `string`  | Active format identifier                               |

Helpers (no `id` argument):

| Helper                          | Description                                      |
| ------------------------------- | ------------------------------------------------ |
| `$colorpicker.tailwind`         | The bundled Tailwind palette object              |
| `$colorpicker.ios`              | The bundled iOS palette object                   |
| `$colorpicker.presets`          | All custom palettes from your colorpicker source |
| `$colorpicker.recent(id)`       | The Recent list for a given swatch               |

Programmatic API — call these on `$colorpicker(id)`:

| Method                    | Description                                  |
| ------------------------- | -------------------------------------------- |
| `.set(value)`             | Set the picker's value (hex, CSS, gradient)  |
| `.setMode('solid'\|'gradient')` | Switch panels                          |
| `.clearRecent()`          | Empty the Recent list for this swatch        |

```html copy
<button id="hero" x-colorpicker></button>

<!-- Read -->
<div :style="`background: ${$colorpicker('hero').css}`"></div>

<!-- Write -->
<button @click="$colorpicker('hero').set('#10b981')">
    Reset to brand green
</button>
```

---

## Styles

### Theme Variables

The picker uses Manifest's standard theme tokens for surface, border, and accent colors, so it inherits your light/dark theme automatically. The most relevant tokens:

| Variable                      | Purpose                                |
| ----------------------------- | -------------------------------------- |
| `--mnfst-color-surface`       | Menu background                        |
| `--mnfst-color-border`        | Borders, sliders, swatch ring          |
| `--mnfst-color-accent`        | Active tab, selected swatch outline    |
| `--mnfst-radius`              | Menu and swatch corner radius          |

Override these globally or in a scoped wrapper to retheme the picker without touching its markup.

### Custom CSS

Class hooks for scoped styling:

| Class                           | Element                                |
| ------------------------------- | -------------------------------------- |
| `.mnfst-colorpicker`            | The swatch element                     |
| `.mnfst-colorpicker-menu`       | The popover/inline menu container      |
| `.mnfst-colorpicker-tab`        | Tab button                             |
| `.mnfst-colorpicker-canvas`     | Saturation/lightness canvas            |
| `.mnfst-colorpicker-slider`     | Hue and alpha sliders                  |
| `.mnfst-colorpicker-swatch`     | Library/Recent swatch tile             |
| `.mnfst-colorpicker-swatch.active` | Currently selected library swatch   |
| `.mnfst-colorpicker-stop`       | Gradient stop handle                   |
| `.mnfst-colorpicker-layer`      | Gradient layer row                     |

```css copy
/* Make the menu wider */
.mnfst-colorpicker-menu {
    width: 360px;
}

/* Square swatches */
.mnfst-colorpicker-swatch {
    border-radius: 0;
}
```
