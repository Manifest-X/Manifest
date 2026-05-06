---
name: manifest-component
description: Use when the contributor wants to create, edit, or extract a reusable component in a Manifest project. Triggers on "make a reusable X", "create a card/banner/hero/cta component", "extract this into a component", "use the same X in multiple places", "make a header/footer". Manifest components are HTML files registered in manifest.json and used as <x-filename> tags. SKIP for one-off page sections that aren't reused.
---

# Creating or editing a component in Manifest

Components in Manifest are plain HTML files registered in `manifest.json`. The file's basename becomes the tag — `card.html` → `<x-card>` — regardless of which folder it sits in. The starter template puts them in `/components/`, but that's a folder convention, not a rule.

## Recipe

1. **Find this project's pattern first.** Look at the existing `components` and `preloadedComponents` arrays in `manifest.json` to see where this project keeps its components, and grep an existing component file to see its style (utility classes, `$modify` usage, etc.). When in doubt — or for a brand-new project — use `/components/`.

2. **Decide the file name.** The basename becomes the tag name. `pricing-card.html` → `<x-pricing-card>`. Use lowercase, hyphen-separated.

3. **Create the component file** in the project's components folder. Structure:
   ```html
   <div class="...">
     <h3 x-text="$modify('heading') || 'Default heading'"></h3>
     <p x-text="$modify('body') || 'Default body'"></p>
     <button x-text="$modify('cta') || 'Click me'"></button>
   </div>
   ```
   - The component should have **one top-level element** (so attributes flow correctly).
   - Use `$modify('attrName')` to expose customization points. Then `<x-pricing-card heading="Pro" body="..." cta="Buy">` will fill them in.
   - For an `<head>` injection (e.g. a component that adds SEO tags when its parent route is active), wrap in `<template data-head>...</template>` inside the component.

4. **Register it in `manifest.json`** with its path. Choose one of:
   - `preloadedComponents` — loads on initial page load. Use for header, footer, anything visible immediately or on the home page.
   - `components` — lazy-loaded on demand. Use for everything else (better initial load).
   ```json
   "components": [
     "components/pricing-card.html"
   ]
   ```

5. **Use it.** Add `<x-pricing-card></x-pricing-card>` (always with closing tag — self-closing won't work) wherever appropriate. If the user said "show three of them", repeat the tag with different attributes — don't loop unless the data is in a registered data source (in which case use Alpine `<template x-for>`).

6. **Extracting an existing block into a component**:
   - Identify the block to extract.
   - Create the component file with that HTML, replacing the dynamic bits with `$modify('...')`.
   - Replace the original block with the new `<x-component>` tag, passing the original values as attributes.
   - Register in `manifest.json`.

7. **Editing an existing component**: just edit the file — all instances update on next page load.

8. **Verify in the preview panel.** Confirm the component renders, attributes flow through, and there are no console errors about a missing component.

## What not to do

- Don't forget to register in `manifest.json` — the component will silently fail to load.
- Don't put multiple top-level elements at the root of a component — attributes from the `<x-tag>` only flow to the first one.
- Don't use frameworks-style props (`{{ heading }}`, `<slot>`) — Manifest uses `$modify()` and child content passthrough only.
- Don't self-close `<x-component />` — use `<x-component></x-component>`.

## Further reading

If the recipe above doesn't cover the situation, consult:
- Components (full `$modify` semantics, `<template data-head>`, edge cases): https://manifestjs.org/docs/core-plugins/components
- Markdown (placing components inside markdown files): https://manifestjs.org/docs/core-plugins/markdown
