---
name: manifest-layout
description: Use when the contributor wants to build or restructure the arrangement of elements on a page — a hero section, a feature grid, a sidebar layout, a pricing table, a card row, a header/footer structure, a dashboard shell, anything responsive. Triggers on "build a [hero/grid/sidebar/dashboard]", "lay these out", "make this responsive", "add a sidebar", "two columns on desktop, one on mobile", "the mobile version should…". Manifest's CSS rewards minimal markup on semantic HTML — this skill enforces that. SKIP for styling a single existing element (use manifest-styling).
---

# Building layouts in Manifest

Manifest's design intent: **minimal markup on semantic HTML, with shared mobile/desktop layouts that flex naturally.** The framework's CSS does the heavy lifting; deep wrapper hierarchies (the kind in default Tailwind templates) are an anti-pattern here.

## Principles

1. **Start from semantic HTML, not from container `<div>`s.** Reach for `<header>`, `<main>`, `<section>`, `<article>`, `<nav>`, `<aside>`, `<footer>`, `<figure>`, `<form>` first. Manifest styles them. A `<div>` is a fallback when none of those fit.

2. **One layout, both screens.** Don't build separate mobile/desktop versions. Use layouts that flex naturally — a `row-wrap` becomes a column on narrow screens without any breakpoint code; a `grow` child shares space with siblings at any width. Reach for Tailwind's `md:`/`lg:` prefixes only when the layout *genuinely* needs to change shape (e.g. sidebar collapses to top-bar at small widths). Only duplicate content under `hidden md:block` + `md:hidden` as a last resort.

3. **No wrapper-only divs.** If a `<div>` exists only to apply one class to its child, hoist the class. If a `<div>` exists only to give padding to its inner content, give the padding to the inner content. If you're nesting three containers to position one element, reach for `row`/`col`/`center` instead.

4. **Composition over duplication.** Three near-identical card-shaped blocks → one component (`<x-card>`) used three times. Repeated container chains are a smell.

5. **Trust the `page` class.** A `<body class="page">` already gives you the header/main/footer grid with auto viewport padding and content-width sections. Don't re-implement this with `max-w-*` chains around every section.

## The default toolkit

When laying things out, reach for these in order:

| Need | Use |
|---|---|
| Vertical stack | `<div class="col gap-4">` (or just `<form>`, which is `col` by default) |
| Horizontal stack | `<div class="row gap-4">` |
| Wrapping row (responsive by default) | `<div class="row-wrap gap-4">` |
| Center one thing in another | `<div class="row center">` or `<div class="col center">` |
| Constrain to content width | `<section>` inside `page > main`, or `<div class="content">` outside it |
| Make a child take remaining space | `class="grow"` (Tailwind) on the child |
| Spacing between siblings | `gap-N` on the parent (Tailwind) — not margins on each child |
| Padding inside | `p-N`, `px-N`, `py-N` (Tailwind) |

## Recipes

### Hero section

```html
<section class="col center gap-6 py-20">
  <h1>Build it. Ship it.</h1>
  <p class="text-content-neutral">One sentence about the value prop.</p>
  <div class="row-wrap gap-3">
    <button class="brand lg">Get started</button>
    <button class="lg ghost">See how</button>
  </div>
</section>
```

Three nested elements (section, heading group, button group). No wrapper divs.

### Feature grid (responsive without breakpoints)

```html
<section>
  <h2>Features</h2>
  <div class="row-wrap gap-6">
    <template x-for="feature in $x.features.list" :key="feature.name">
      <article class="col gap-2 grow min-w-[240px]">
        <h3 x-text="feature.name"></h3>
        <p x-text="feature.description"></p>
      </article>
    </template>
  </div>
</section>
```

`row-wrap` + `grow` + `min-w-[240px]` gives a responsive grid that wraps naturally — no `md:grid-cols-3 lg:grid-cols-4` chain needed.

### Sidebar layout (where breakpoints earn their keep)

For a **persistent inline navigation rail**, use `<nav>` — not `<aside>`. In Manifest, `<aside>` is reserved for popover-style sidebars (drawers that slide in/out); see "Popover widgets" below.

```html
<div class="col md:row gap-6">
  <nav class="col gap-2 md:w-60">
    <a x-route="dashboard" href="/dashboard">Dashboard</a>
    <a x-route="settings" href="/settings">Settings</a>
  </nav>
  <main class="grow">
    <!-- content -->
  </main>
</div>
```

Stacks on mobile, side-by-side on desktop, no markup duplication.

For an **off-canvas drawer-style sidebar** (mobile menu, settings panel, filter pane that opens on demand), use `<aside popover>`:

```html
<button popovertarget="menu">Menu</button>
<aside popover id="menu" class="appear-start col gap-4 p-4">
  <nav class="col gap-2">
    <a href="/dashboard">Dashboard</a>
    <a href="/settings">Settings</a>
  </nav>
</aside>
```

`appear-start` makes it slide from the inline-start (left in LTR, right in RTL). Without it, slides from inline-end.

### Card row

```html
<div class="row-wrap gap-4">
  <template x-for="item in $x.products" :key="item.id">
    <article class="col gap-2 p-4 bg-surface-1 rounded grow min-w-[200px]">
      <img :src="item.image" :alt="item.name">
      <h3 x-text="item.name"></h3>
      <p x-text="item.description"></p>
    </article>
  </template>
</div>
```

### Two-column section (text + image)

```html
<section class="row-wrap items-center gap-8">
  <div class="col gap-3 grow min-w-[280px]">
    <h2>Heading</h2>
    <p>Body copy.</p>
  </div>
  <img class="grow min-w-[280px] rounded" src="/hero.webp" alt="…">
</section>
```

Wraps to a column on narrow screens with no breakpoint code.

## Popover widgets — not layout primitives

These are interactive overlays. Once opened, they're rendered above the page (the browser's popover layer), so their **DOM position doesn't affect page layout**. Place them anywhere in markup; their visual position comes from their own behaviour, not from where they sit in the flow.

| Element | Trigger | What it is |
|---|---|---|
| `<dialog popover id="x">` | `<button popovertarget="x">` | Modal — light-dismissable by default; `popover="manual"` for blocking |
| `<aside popover id="x">` | `<button popovertarget="x">` | Slide-in drawer (default: from inline-end; add `appear-start` for inline-start) |
| `<menu popover id="x">` | `<button x-dropdown="x">` | Dropdown menu (also `.hover` and `.context` modifiers) |
| `<details><summary>` | (native click on summary) | Inline accordion; `<details name="group">` makes them mutually exclusive |

Inside dialogs and menus, Manifest auto-styles `<header>/<main>/<footer>` as direct children for the standard widget layout. For dropdown menu items, use `<li>`, `<a>`, `<button>`, `<label><input></label>`, `<small>` (group title), `<hr>` (divider) as direct children.

When you build a layout, **don't try to fit these into the page's flex/grid containers** — put them at a sensible spot in the markup (often the end of the relevant section) and let the popover system handle positioning.

## Recipe (what to actually do)

1. **Read the surrounding HTML** to see the project's markup density. Match it.
2. **Sketch the layout in semantic HTML first.** What's a heading, what's a list, what's a button? Don't open a `<div>` until you've used up the semantic options.
3. **Apply Manifest layout classes** (`row`/`col`/`center`/`content`) before reaching for raw Tailwind flex/grid utilities.
4. **Make it flex naturally** — `row-wrap` + `grow` + `min-w-[Npx]` gets you most responsive grids without a single breakpoint.
5. **Use `md:`/`lg:` only when the layout genuinely changes shape**, not for "the desktop version is wider".
6. **Verify in the preview panel at multiple widths** — use `preview_resize` to check 375px (phone), 768px (tablet), and 1280px (desktop). If the layout breaks badly at one width, fix it; don't paper over it with a breakpoint that hides content.

## What not to do

- **Don't open a `<div>` you don't need.** If hoisting a class to the child works, do that.
- **Don't duplicate content for mobile vs desktop** (`hidden md:block` + `md:hidden`). The contributor will edit one and forget the other, and it bloats the page weight.
- **Don't reach for CSS Grid (`grid grid-cols-3`) when `row-wrap` + `grow` would work.** Grid is right when you genuinely need a fixed grid; flex-wrap is right for "lay these out and let them breathe".
- **Don't manually constrain section width** with `max-w-5xl mx-auto px-6` chains. If the body has `class="page"` and you're inside `<main>`, sections are already content-width. If not, use `<div class="content">`.
- **Don't reinvent `<button>` as a `<div>` for "design reasons".** Manifest auto-styles `<button>` and it's accessible by default.
- **Don't add `gap`/`padding` to every direct child.** Set `gap` on the parent flex container; the children stay clean.

## Further reading

If the recipe above doesn't cover the situation, consult:
- Utilities (`page`, `content`, `row`, `col`, `center`, full layout class list): https://manifestjs.org/docs/styles/utilities
- Sidebars (popover-style drawers, `appear-start`, custom transitions): https://manifestjs.org/docs/elements/sidebars
- Dialogs (modal layout with `<header>/<main>/<footer>`, nesting, light dismiss): https://manifestjs.org/docs/elements/dialogs
- Dropdowns (full positioning class list, hover/context modifiers, content patterns): https://manifestjs.org/docs/elements/dropdowns
