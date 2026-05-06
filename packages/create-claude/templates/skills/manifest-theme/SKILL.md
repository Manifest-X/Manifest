---
name: manifest-theme
description: Use when the contributor wants to change the visual style of a Manifest project — colors, fonts, spacing, border radius, dark mode behavior. Triggers on "change the brand color", "use a warmer palette", "make buttons rounder", "use a different font", "more spacing", "darker text". Edits go in manifest.theme.css. SKIP for one-off styling on a single element (just add a utility class).
---

# Adjusting the theme in Manifest

All theme values live in `manifest.theme.css` as CSS custom properties. **Always edit the variable, never hardcode colors/fonts/sizes elsewhere.** Changing a variable updates every element that uses it.

## Recipe

1. **Read `manifest.theme.css`** to see what variables already exist. They are organized into:
   - **Palette**: `--color-50` through `--color-950` (lightest to darkest, neutral by default)
   - **Semantic surface roles**: `--color-page`, `--color-surface-1/2/3`, `--color-popover-surface`, `--color-field-surface`
   - **Semantic text roles**: `--color-content-stark`, `--color-content-neutral`, `--color-content-subtle`
   - **Brand**: `--color-brand-surface`, `--color-brand-surface-hover`, `--color-brand-inverse`, `--color-brand-content`
   - **Accent**: `--color-accent-surface`, `--color-accent-surface-hover`, `--color-accent-inverse`, `--color-accent-content`
   - **Status**: `--color-positive-*`, `--color-negative-*`
   - **Sizing**: `--radius`, `--spacing` (base unit), `--spacing-content-width`, `--spacing-field-padding`, `--spacing-field-height`, `--spacing-popover-offset`
   - **Effects**: `--transition`, `--tooltip-hover-delay`
   - **Fonts**: `--font-sans` (and add others as needed)

2. **Translate the request to a variable**:
   - "Change the brand color" → `--color-brand-surface`, `--color-brand-surface-hover`, `--color-brand-inverse`, `--color-brand-content` (all four — they form a coordinated set).
   - "Make buttons/cards rounder" → `--radius`.
   - "More breathing room" → `--spacing` (base unit, multiplied throughout).
   - "Wider content area" → `--spacing-content-width`.
   - "Different font" → `--font-sans`. If using a web font, add the `<link>` to `index.html` `<head>` first.
   - "Darker page background" / "lighter text" → these are usually controlled by the palette. Adjust the semantic variable (e.g. `--color-page`), or shift the underlying `--color-50`/`--color-950` to recolor everything.

3. **Edit the variable** in the `:root, ::selection` block.

4. **Check dark mode.** The `.dark` block at the bottom overrides specific variables for dark mode. If the user changed a brand or content color, verify the dark-mode override still works (the default flips brand/accent to lighter shades for dark backgrounds). Update the `.dark` overrides if needed.

5. **Don't add new utility classes for theming.** Manifest auto-generates utility classes from CSS variables. If `--color-brand-surface` exists, then `bg-brand-surface`, `text-brand-surface`, `border-brand-surface` all just work in HTML — no need to define them.

6. **Verify in the preview panel** in both light and dark mode (toggle the `.dark` class on `<html>` to test). Confirm contrast is still readable.

## What not to do

- **Don't hardcode colors in HTML or component files** (`style="color: #ff0000"`, `class="bg-[#ff0000]"`). Always reference a theme variable.
- **Don't add new theme variables for one-off elements** — use a utility class with an existing variable.
- **Don't edit `lib/manifest.css` or `lib/manifest.min.css`** — those are framework files. Only edit `manifest.theme.css`.
- Don't change the palette `--color-50`–`--color-950` casually — it cascades into every semantic variable. For a brand color shift, change `--color-brand-*` only.

## Further reading

If the recipe above doesn't cover the situation, consult:
- Theme (full variable list, dark mode overrides, customization): https://manifestjs.org/docs/styles/theme
- Color Themes (light/dark switching, `prefers-color-scheme`): https://manifestjs.org/docs/core-plugins/color-themes
- Utilities (auto-generated utility class names from theme variables): https://manifestjs.org/docs/styles/utilities
