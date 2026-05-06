---
name: manifest-styling
description: Use when the contributor wants to style a specific element or section in a Manifest project — change a color, adjust spacing, lay things out in a row or column, center something, add a card look, make something into a button, etc. Triggers on "make this red/green/branded", "lay these in a grid/row/column", "center this", "add a border", "make it look like a card", "add some space between these". Reach for Manifest's pre-styled HTML, semantic classes, and theme-derived utilities — not inline styles or hardcoded colors. SKIP for project-wide brand/theme changes (use manifest-theme instead).
---

# Styling specific elements in Manifest

Manifest gives you five layers to style with. Always pick the lowest layer that does the job — it stays consistent with the theme and other components.

## The five layers, in order of preference

### 1. Pre-styled raw HTML

Manifest's CSS targets nearly every common HTML element directly. **Use the semantic element first** — only reach for utility classes when you need a variation. Coverage:

**Text & inline:**
- `<h1>`–`<h6>` — heading scale
- `<p>`, `<small>`, `<figcaption>`, `<blockquote>` — body text variants
- `<a>` — links (with hover transitions)
- `<b>`/`<strong>`, `<i>`/`<em>`, `<mark>`, `<code>` (inline), `<kbd>` — inline emphasis & code

**Lists:**
- `<ul>`, `<ol>`, `<li>` — markers aligned with content; nested lists supported
- `<li x-icon="lucide:name">` — icon as the list marker

**Forms & inputs:**
- `<form>` — vertical flex with gaps
- `<label>` — pairs with nested input for label+field styling
- `<input>` of every type — `text`, `email`, `password`, `search`, `number`, `date`, `time`, `file`, `color`, `range`, `checkbox`, `radio`
- `<input type="checkbox" role="switch">` — toggle switch
- `<textarea>`, `<select>` — multiline / native dropdown
- `<button>` — branded button (color/appearance/size modifiers via `brand`/`accent`/`ghost`/`outlined`/`sm`/`lg` etc.)
- `<fieldset>`, `<legend>` — grouped fields with caption

**Tables:**
- `<table>` with `<thead>`/`<tbody>`/`<tfoot>`/`<tr>`/`<th>`/`<td>` — formatted table

**Interactive widgets (popovers, accordions, etc.):**
- `<details>` + `<summary>` — inline accordion (add `name="group"` for mutually-exclusive grouping). **Inline disclosure, not a popover.**
- `<dialog popover>` — modal (add `popover="manual"` to disable light dismiss)
- `<aside popover>` — slide-in sidebar/drawer (add `appear-start` to slide from inline-start)
- `<menu popover>` — dropdown menu (paired with `x-dropdown="menu-id"` on a button)

**Media & figures:**
- `<img>` — responsive defaults (max-width: 100%)
- `<figure>` + `<figcaption>` — captioned media
- `<svg>`, `<picture>` — basic normalization

**Page structure:**
- `<header>`, `<main>`, `<section>`, `<article>`, `<nav>`, `<footer>` — semantic landmarks; auto-arranged by `<body class="page">` for websites
- `<hr>` — divider

**Utility classes for text styling:** `h1`–`h6`, `paragraph`, `small`, `caption` apply heading/body styles to any element (e.g. a `<span>` or `<div>`). Color modifiers: `stark`/`neutral`/`subtle` (content levels), `brand`/`accent`/`positive`/`negative` (semantic).

If the user wants a button-styled link, use `<a>` with the `button` class — but most of the time a real `<button>` is what they want.

### 2. Manifest semantic classes

Modify the appearance of an element with these (no need to invent custom classes):

- **Layout**: `page` (top-level body wrapper for websites), `content` (centered, content-width for websites), `row`/`row-wrap`, `col`/`col-wrap`, `center` (centers contents in a flex container).
- **Color** (on buttons, inputs, text): `brand`, `accent`, `negative`, `positive`.
- **Appearance** (mostly on buttons): `ghost` (transparent until hover), `outlined`, `hug` (size-to-content), `selected`, `transparent`.
- **Size** (on buttons/inputs): `sm`, `lg`.
- **Typography helpers**: `h1`–`h6`, `p`, `small`, `caption` apply heading/body styles to any element. `prose` makes a container's long-form text more readable (apply on the parent of the article/markdown).
- **Misc**: `unstyle` (opt out of Manifest defaults on a single element), `no-focus` (remove focus outline), `no-scrollbar` (hide scrollbar), `overlay-dark`/`overlay-light` (adds ::after overlays to banners and contrasts child text), `trailing` (push trailing icon to right edge).

Combine freely: `<button class="brand sm ghost">Cancel</button>`.

### 3. Theme-derived utilities

For one-off styling that should still respect the theme, use the auto-generated utility classes built from CSS variables in `manifest.theme.css`. Pattern: `<utility-prefix>-<variable-name>`.

- Background: `bg-brand-surface`, `bg-surface-1`, `bg-page`, `bg-accent-surface`
- Text: `text-content-stark`, `text-content-neutral`, `text-content-subtle`, `text-brand-content`
- Border: `border-line`, `border-brand-surface`
- Sizing: `p-(--spacing-field-padding)`, `rounded-(--radius)`

These only work for variables that exist in `manifest.theme.css`. If you need a value that isn't there, add the variable first (use the `manifest-theme` skill).

### 4. Tailwind utilities

Tailwind is opt-in via `data-tailwind` on the script tag in `index.html`. Default ON in the starter. Use Tailwind for layout/spacing utilities the semantic classes don't cover: `gap-4`, `mt-8`, `grid grid-cols-3`, `aspect-video`, `max-w-2xl`, `shadow`, etc.

### 5. Custom styles

For overrides to raw HTML prestyles, or highly repetetive/complex styles, add custom rules in a stylesheet. If the rules are not exhaustive, consider locating them at the bottom of `manifest.theme.css` for containment.

## Recipe

1. **Read the surrounding HTML** to see what styling layer the file already uses (semantic classes? Tailwind? Mix?). Match the existing convention.
2. **Pick the lowest layer that works.** Don't reach for Tailwind if a semantic class fits. Don't reach for a semantic class if a raw `<button>` is enough.
3. **Apply.** Edit the class attribute (or wrap in the right element).
4. **Verify in the preview panel.** Confirm visually. Test both light and dark mode if the change involves color.

## What not to do

- **No inline `style="..."`** for anything that could use a utility class or theme variable.
- **No hardcoded colors** (`color: #ff0000`, `bg-[#ff0000]`). Always use a theme variable or the `brand`/`accent`/`negative`/`positive` classes.
- **No new component** for a one-off styled element. Components are for *reuse* — see the `manifest-component` skill.
- **No Tailwind for things the semantic classes already do.** Don't write `<div class="flex flex-row">` when `<div class="row">` exists.
- **No editing `lib/manifest.css`** — that's the framework. Theme tweaks go in `manifest.theme.css`.

## Further reading

If the recipe above doesn't cover the situation, consult:
- Utilities (full semantic class list, `page` layout, form modifiers, typography helpers): https://manifestjs.org/docs/styles/utilities
- Theme (variables and how utilities derive from them): https://manifestjs.org/docs/styles/theme
- Reset (Manifest's base styles applied to raw HTML): https://manifestjs.org/docs/styles/reset
