# Code plugin markdown fixtures

This file is consumed by the `/code` test route via `x-markdown` to verify the
markdown plugin emits `<pre x-code>` and that every fence-info-string token
flows through correctly.

## Plain fence

```
no language at all
hljs should auto-detect (or skip)
```

## Language only

```javascript
function fromMarkdown() {
  return 'rendered via marked → pre x-code';
}
```

## Language + title

```css "theme.css"
:root {
  --color-page: white;
}
```

## With every modifier

```javascript "Full demo" numbers copy collapse="5"
// Line 1
// Line 2
// Line 3
// Line 4
// Line 5
// Line 6 — should be hidden until expanded
// Line 7
// Line 8
const last = 'collapsed';
```

## Editable from markdown

```javascript edit "Try editing"
const fromMd = 'this is editable';
```

## `::: frame demo` — render + show source

::: frame demo
<button style="padding: 0.4rem 0.9rem; background: steelblue; color: white; border: 0; border-radius: 0.25rem">Demo button</button>
:::

## Code group via div x-code-group

<div x-code-group>

```html "HTML"
<button class="primary">Click</button>
```

```css "CSS"
.primary { background: tomato; }
```

```javascript "JS"
const btn = document.querySelector('.primary');
```

</div>
