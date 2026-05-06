# Dropdowns

---

## Setup

Dropdown styles are included in Manifest CSS or a standalone stylesheet, both referencing [theme](/docs/styles/theme) variables.

Dropdown functionality is included in `manifest.js` with all core plugins, or it can be selectively loaded.

<x-code-group copy>

```html "Manifest CSS / JS"
<!-- Manifest CSS -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.code.min.css" />

<!-- Manifest JS -->
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"></script>
```

```html "Standalone"
<!-- Dropdown styles only -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.code.min.css" />

<!-- Manifest JS: dropdown plugin only -->
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"
  data-plugin="dropdown"></script>
```

</x-code-group>

::: brand icon="lucide:info"
Older browser versions require polyfills like Oddbird's <a href="https://github.com/oddbird/popover-polyfill" target="_blank">popover</a> and <a href="https://github.com/oddbird/popover-polyfill" target="_blank">position-area</a> scripts, which mimic the HTML and CSS abilities required for dropdowns.
:::

For OS dropdowns, see [selects](/docs/elements/selects).

---

## Default

Dropdowns use the `<menu>` element as a <a href="https://developer.mozilla.org/en-US/docs/Web/API/Popover_API" target="_blank">popover</a>. The `<button>` that opens the dialog requires the `x-dropdown` attribute, matching the menu ID.

::: frame
<button x-dropdown="basic-menu-preview">Open Menu</button>

<menu popover id="basic-menu-preview">
    <li>Item 1</li>
    <li>Item 2</li>
    <li>Item 3</li>
</menu>
:::

```html copy
<button x-dropdown="basic-menu">Open Menu</button>

<menu popover id="basic-menu">
    <li>Item 1</li>
    <li>Item 2</li>
    <li>Item 3</li>
</menu>
```

---

## Hover

Add the `hover` modifier to `x-dropdown` for mouseover dropdowns:

::: frame
<button x-dropdown.hover="hover-menu-preview">Hover Me</button>

<menu popover id="hover-menu-preview">
    <li>Item 1</li>
    <li>Item 2</li>
    <li>Item 3</li>
</menu>
:::

```html copy
<button x-dropdown.hover="hover-menu">Hover Me</button>

<menu popover id="hover-menu">
    <li>Item 1</li>
    <li>Item 2</li>
    <li>Item 3</li>
</menu>
```

Hover dropdowns include a small delay to prevent accidental auto-close if the mouse briefly leaves the trigger or menu area.

::: brand icon="lucide:info"
Avoid mixing `x-dropdown.hover` and `x-tooltip` on the same button, since they both use hover state.
:::

---

## Context Menu

Add the `context` modifier to `x-dropdown` for right-click dropdowns. The menu appears at the cursor position, replacing the browser's native context menu on the trigger element.

::: frame
<div x-dropdown.context="context-menu-preview" style="padding: 2rem; border: 1px dashed var(--color-line, #ccc); border-radius: var(--radius, 0.5rem); text-align: center; color: var(--color-content-subtle);">Right-click this area</div>

<menu popover id="context-menu-preview">
    <li>Cut</li>
    <li>Copy</li>
    <li>Paste</li>
</menu>
:::

```html copy
<div x-dropdown.context="context-menu">Right-click this area</div>

<menu popover id="context-menu">
    <li>Cut</li>
    <li>Copy</li>
    <li>Paste</li>
</menu>
```

The trigger element does not need to be a `<button>` since the menu is opened programmatically on right-click rather than via the `popovertarget` attribute's click-to-toggle behavior. The menu still uses the Popover API for rendering and stacking.

---

## Nesting

Create multi-level navigation menus with nested dropdowns.

::: frame
<button x-dropdown="nested-menu-preview">Main Menu</button>

<menu popover id="nested-menu-preview">
    <li>Item 1</li>
    <li>Item 2</li>
    <button x-dropdown="submenu-1-preview"><span>Submenu</span><span x-icon="lucide:chevron-right" class="trailing"></span></button>
    <menu popover id="submenu-1-preview">
        <li>Item 1</li>
        <li>Item 2</li>
        <button x-dropdown.hover="submenu-2-preview"><span>Hover Submenu</span><span x-icon="lucide:chevron-right" class="trailing"></span></button>
        <menu popover id="submenu-2-preview">
            <li>Item 1</li>
            <li>Item 2</li>
            <li>Item 3</li>
        </menu>
    </menu>
    <li>Item 4</li>
</menu>
:::

```html copy
<button x-dropdown="nested-menu">Main Menu</button>

<!-- Main Menu -->
<menu popover id="nested-menu">
    <li>Item 1</li>
    <li>Item 2</li>
    <button x-dropdown="submenu-1"><span>Submenu</span><span x-icon="lucide:chevron-right" class="trailing"></span></button>
    <li>Item 4</li>
    
    <!-- Submenu 1 -->
    <menu popover id="submenu-1">
        <li>Item 1</li>
        <li>Item 2</li>
        <button x-dropdown.hover="submenu-2"><span>Hover Submenu</span><span x-icon="lucide:chevron-right" class="trailing"></span></button>
        
        <!-- Submenu 2 -->
        <menu popover id="submenu-2">
            <li>Item 1</li>
            <li>Item 2</li>
            <li>Item 3</li>
        </menu>

    </menu>
</menu>
```

Nested dropdowns automatically position themselves to avoid overlapping and maintain proper navigation flow.

---

## Positioning

Menus have utility classes like `top` and `bottom` to position them in relation to their trigger buttons. If no class is set, menus default to `bottom-start`, or `end-start` if nested.

::: frame
<div class="col gap-4">
    <!-- Basic Directions -->
    <div>
        <small class="block mb-2">Basic</small>
        <div class="row-wrap gap-2">
            <button x-dropdown="menu-top-preview">top</button>
            <menu popover id="menu-top-preview" class="top">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
            <button x-dropdown="menu-bottom-preview">bottom</button>
            <menu popover id="menu-bottom-preview" class="bottom">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
            <button x-dropdown="menu-start-preview">start</button>
            <menu popover id="menu-start-preview" class="start">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
            <button x-dropdown="menu-end-preview">end</button>
            <menu popover id="menu-end-preview" class="end">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
            <button x-dropdown="menu-center-preview">center</button>
            <menu popover id="menu-center-preview" class="center">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
        </div>
    </div>
    
    <!-- Top/Bottom alignment -->
    <div>
        <small class="block mb-2">Top/Bottom alignment</small>
        <div class="row-wrap gap-2">
            <button x-dropdown="menu-top-start-preview">top-start</button>
            <menu popover id="menu-top-start-preview" class="top-start">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
            <button x-dropdown="menu-top-end-preview">top-end</button>
            <menu popover id="menu-top-end-preview" class="top-end">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
            <button x-dropdown="menu-bottom-start-preview">bottom-start</button>
            <menu popover id="menu-bottom-start-preview" class="bottom-start">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
            <button x-dropdown="menu-bottom-end-preview">bottom-end</button>
            <menu popover id="menu-bottom-end-preview" class="bottom-end">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
        </div>
    </div>
    
    <!-- Start/End alignment -->
    <div>
        <small class="block mb-2">Start/End alignment</small>
        <div class="row-wrap gap-2">
            <button x-dropdown="menu-start-top-preview">start-top</button>
            <menu popover id="menu-start-top-preview" class="start-top">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
            <button x-dropdown="menu-start-bottom-preview">start-bottom</button>
            <menu popover id="menu-start-bottom-preview" class="start-bottom">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
            <button x-dropdown="menu-end-top-preview">end-top</button>
            <menu popover id="menu-end-top-preview" class="end-top">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
            <button x-dropdown="menu-end-bottom-preview">end-bottom</button>
            <menu popover id="menu-end-bottom-preview" class="end-bottom">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
        </div>
    </div>

    <!-- Corner alignment -->
    <div>
        <small class="block mb-2">Corner alignment</small>
        <div class="row-wrap gap-2">
            <button x-dropdown="menu-start-top-corner-preview">top-start-corner</button>
            <menu popover id="menu-start-top-corner-preview" class="start-top-corner">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
            <button x-dropdown="menu-end-top-corner-preview">top-end-corner</button>
            <menu popover id="menu-end-top-corner-preview" class="top-end-corner">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
            <button x-dropdown="menu-start-bottom-corner-preview">bottom-start-corner</button>
            <menu popover id="menu-start-bottom-corner-preview" class="bottom-start-corner">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
            <button x-dropdown="menu-end-bottom-corner-preview">bottom-end-corner</button>
            <menu popover id="menu-end-bottom-corner-preview" class="end-bottom-corner">
                <li>Item 1</li>
                <li>Item 2</li>
            </menu>
        </div>
    </div>
</div>
:::

```html "Examples"
<!-- Top -->
<menu popover id="..." class="top">...</menu>

<!-- Bottom with start alignment -->
<menu popover id="..." class="bottom-start">...</menu>

<!-- Start with top alignment -->
<menu popover id="..." class="start-top">...</menu>

<!-- Top start corner (either version works) -->
<menu popover id="..." class="top-start-corner">...</menu>
<menu popover id="..." class="start-top-corner">...</menu>
```

Regardless of a set class, dropdowns overflowing the viewport will attempt to stay onscreen with default fallback positions.

---

## Templating

HTML IDs must identify single elements on a page, and generating multiple dropdowns in a <a href="https://alpinejs.dev/essentials/templating#looping-elements" target="_blank">template loop</a> requires each dropdown be assigned a unique ID. These can be generated with Alpine using template literals like `${i}`.

::: frame
<template x-for="i in 3" :key="i">
    <div>
        <button x-dropdown="`template-menu-preview-${i}`" x-text="`Menu ${i}`"></button>
        <menu popover :id="`template-menu-preview-${i}`">
            <li>Item 1</li>
            <li>Item 2</li>
        </menu>
    </div>
</template>
:::

```html numbers copy
<template x-for="i in 3" :key="i">

    <!-- Multiple elements need to be wrapped in a container, since template tags only recognize their first child. -->
    <div>

        <!-- Button template -->
        <button x-dropdown="`template-menu-${i}`" x-text="`Menu ${i}`"></button>
        
        <!-- Menu template -->
        <menu popover :id="`template-menu-${i}`">
            <li>Item 1</li>
            <li>Item 2</li>
        </menu>

    </div>

</template>
```

---

## Content

Use `<li>` elements for generic options in a dropdown, with Alpine's `@click` directive giving them utility. A variety of other elements support additional dropdown content needs.

::: frame
<button x-dropdown="content-menu"><span>Dropdown</span><span x-icon="lucide:chevron-down" class="trailing"></span></button>

<menu popover id="content-menu" class="w-60 max-h-160">
    <small>List Items</small>
    <li @click="alert('Hello world')">Do Something</li>
    <li><span x-icon="lucide:house"></span><span>Icon</span></li>
    <li><span>Trailing</span><kbd class="trailing">⌘</kbd><kbd>D</kbd></li>
    <li class="brand">Brand</li>
    <li class="accent">Accent</li>
    <li class="positive">Positive</li>
    <li class="negative">Negative</li>
    <hr>
    <small>Links</small>
    <a href="#"><span x-icon="lucide:home"></span>Home</a>
    <a href="#"><span x-icon="lucide:settings"></span><span>Settings</span><span x-icon="lucide:external-link" class="trailing"></span></a>
    <hr>
    <small>Buttons</small>
    <button><span x-icon="lucide:copy"></span><span>Copy</span></button>
    <button><span x-icon="lucide:edit"></span><span>Edit</span></button>
    <hr>
    <small>Checkboxes</small>
    <label><input type="checkbox" /><span>Lorem ipsum dolar sit amet</span></label>
    <label><input type="checkbox" /><span>Consectetur adipiscing elit</span></label>
    <hr>
    <small>Radios</small>
    <label><input type="radio" id="option-a" name="group-preview" checked /><span>Option A</span></label>
    <label><input type="radio" id="option-b" name="group-preview" /><span>Option B</span></label>
    <label><input type="radio" id="option-c" name="group-preview" /><span>Option C</span></label>
    <hr>
    <small>Switches</small>
    <label for="switch">Switch 1<input id="switch" role="switch" type="checkbox" checked /></label>
    <label for="switch">Switch 2<input id="switch" role="switch" type="checkbox"/></label>
    <hr>
    <small>Text Inputs</small>
    <input placeholder="Text input" />
    <textarea placeholder="Textarea"></textarea>
</menu>
:::

```html numbers copy
<button x-dropdown="content-menu"><span>Dropdown</span><span x-icon="lucide:chevron-down" class="trailing"></span></button>

<menu popover id="content-menu" class="w-60 max-h-160">

    <small>List Items</small>
    <li @click="alert('Hello world')">Do Something</li>
    <li><span x-icon="lucide:house"></span><span>Icon</span></li>
    <li><span>Trailing</span><kbd class="trailing">⌘</kbd><kbd>D</kbd></li>
    <li class="brand">Brand</li>
    <li class="accent">Accent</li>
    <li class="negative">Negative</li>

    <hr>

    <small>Links</small>
    <a href="#"><span x-icon="lucide:home"></span>Home</a>
    <a href="#"><span x-icon="lucide:settings"></span><span>Settings</span><span x-icon="lucide:external-link" class="trailing"></span></a>

    <hr>

    <small>Buttons</small>
    <button><span x-icon="lucide:copy"></span><span>Copy</span></button>
    <button><span x-icon="lucide:edit"></span><span>Edit</span></button>

    <hr>

    <small>Checkboxes</small>
    <label><input type="checkbox" /><span>Lorem ipsum dolar sit amet</span></label>
    <label><input type="checkbox" /><span>Consectetur adipiscing elit</span></label>

    <hr>

    <small>Radios</small>
    <label><input type="radio" id="option-a" name="group-preview" checked /><span>Option A</span></label>
    <label><input type="radio" id="option-b" name="group-preview" /><span>Option B</span></label>
    <label><input type="radio" id="option-c" name="group-preview" /><span>Option C</span></label>

    <hr>

    <small>Switches</small>
    <label for="switch">Switch 1<input id="switch" role="switch" type="checkbox" checked /></label>
    <label for="switch">Switch 2<input id="switch" role="switch" type="checkbox"/></label>

    <hr>

    <small>Text Inputs</small>
    <input placeholder="Text input" />
    <textarea placeholder="Textarea"></textarea>

</menu>
```

Use the following elements as direct chilren of a dropdown `<menu>`:

- `<small>` - Group titles
- `<hr>` - Dividers
- `<li>` - Generic options
- `<button>` - Button options (i.e. triggers for sub-dropdowns)
- `<a>` - Links
- `<label>` - Wrappers for radios, checkboxes, and switches
- `<input>` - Single line text fields
- `<textarea>` - Multi-line text fields

And use `<span>` within applicable elements above for icons, truncating text with ellipsis, and trailing content.

---

## Styles

### Theme

Default dropdowns use the following [theme](/docs/styles/theme) variables:

| Variable | Purpose |
|----------|----------|
| `--color-popover-surface` | Menu background color |
| `--color-content-stark` | Menu text color |
| `--color-field-surface` | Hover background color |
| `--color-content-neutral` | Section title color |
| `--color-line` | Divider color |
| `--spacing-popover-offset` | Offset from trigger element |

---

### Tailwind CSS

If using Tailwind, individual menus can be customized with utility classes. Menus taller than a max height will vertically scroll.

::: frame
<button x-dropdown="menu-wide-preview"">Offset & Widen</button>
<menu popover id="menu-wide-preview" class="w-100 !m-6">
    <li>Lorem ipsum dolar sit amet</li>
    <li>Consectetur adipiscing elit</li>
    <li>Sed do eiusmod tempor incididunt</li>
</menu>
:::

```html copy
<button x-dropdown="menu-wide-preview"">Offset & Widen</button>
<menu popover id="menu-wide-preview" class="w-100 !m-6">
    <li>Lorem ipsum dolar sit amet</li>
    <li>Consectetur adipiscing elit</li>
    <li>Sed do eiusmod tempor incididunt</li>
</menu>
```

---

### Customization

Modify base dropdown styles with custom CSS for the `menu[popover]` selector.

::: frame
<style>
menu[popover].custom {
    background-color: #f0f8ff;
    border: 2px solid #3b82f6;
    border-radius: 12px;
    box-shadow: 0 8px 25px rgba(59, 130, 246, 0.3);

    & :where(li, a, button, label) {
        color: #1e40af;
        border-radius: 8px;
    }

    & :where(li, a, button, label):hover {
        background-color: #dbeafe;
    }
}
</style>

<button x-dropdown="custom-menu-preview">Custom Menu</button>
<menu popover id="custom-menu-preview" class="custom">
    <li>Custom Item 1</li>
    <li>Custom Item 2</li>
    <li>Custom Item 3</li>
</menu>
:::

```css copy
menu[popover] {
    background-color: #f0f8ff;
    border: 2px solid #3b82f6;
    border-radius: 12px;
    box-shadow: 0 8px 25px rgba(59, 130, 246, 0.3);

    /* Any relevant options */
    & :where(li, a, button, label) {
        color: #1e40af;
        border-radius: 8px;

        &:hover {
            background-color: #dbeafe;
        }
    }
}
```

