# Date Pickers

Calendar dates, ranges, and times with native fallbacks and full localization.

---

## Setup

Date picker styles are included in Manifest CSS or a standalone stylesheet, both referencing [theme](/docs/styles/theme) variables.

Date picker functionality is included in `manifest.js` with all core plugins, or it can be selectively loaded.

<div x-code-group copy>

```html "Manifest CSS / JS"
<!-- Manifest CSS -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.css" />

<!-- Manifest JS -->
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"></script>
```

```html "Standalone"
<!-- Date picker styles only, with dropdown dependency -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.datepicker.css" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.dropdown.css" />

<!-- Manifest JS: datepicker plugin only -->
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"
  data-plugins="datepicker"></script>
```

</div>

::: brand icon="lucide:info"
Calendar menus piggyback on [dropdown](/docs/elements/dropdowns) styles and popover behavior, so the dropdown stylesheet loads as a dependency. Navigation chevrons are baked into the CSS as the `--icon-previous` / `--icon-next` [theme](/docs/styles/theme) variables — no icons plugin needed, and overridable like any other token.
:::

---

## Field

### Native Input

The simplest date field is a native `<input type="date">`, displaying the browser's built-in picker when pressed. No plugin required.

<div x-code-group>

```html copy
<input type="date">
```

::: frame
<input type="date" style="max-width: 16rem;">
:::

</div>

---

### Picker Field

For full control over content, format, and styling, add `x-date` to an input. The plugin renders a themed calendar dropdown under the field and writes the selection back as a localized display value.

<div x-code-group>

```html copy
<input x-date placeholder="Select a date">
```

::: frame
<input x-date placeholder="Select a date" style="max-width: 16rem;">
:::

</div>

Triggers aren't input-specific — a `<button x-date>` opens the same dropdown, with its authored text serving as the placeholder until the selection replaces it. Triggers with element children (icons, custom layout) keep their content untouched; display the value yourself with `x-model` or [`$date()`](#magic-method).

<div x-code-group>

```html copy
<button x-date>Pick a date</button>
```

::: frame
<button x-date>Pick a date</button>
:::

</div>

Keep the authored `type="date"` for graceful degradation: until the plugin loads (or if JavaScript is disabled), the browser's native picker serves as the fallback, and its `min`/`max` attributes carry over.

```html copy
<input x-date type="date" min="2026-01-01" max="2026-12-31">
```

#### Default Value

Seed the field with a `value` attribute in ISO format (`YYYY-MM-DD`) — the same value a native date input would carry.

```html copy
<input x-date value="2026-06-15">
```

For two-way reactive binding, use `x-model` instead. When both are present, `x-model` wins. The model holds the ISO value; the field displays the localized format.

<div x-code-group>

```html copy
<div x-data="{ when: '' }">
    <input x-date x-model="when" placeholder="Select a date">
    <span x-text="when"></span>
</div>
```

::: frame
<div class="row-wrap items-center gap-4" x-data="{ when: '' }">
    <input x-date x-model="when" placeholder="Select a date" style="max-width: 16rem;">
    <p x-text="when || '—'"></p>
</div>
:::

</div>

#### Form Participation

Add a `name` attribute to submit with a `<form>`. The plugin synthesizes a paired hidden input carrying the ISO value and keeps it in sync. The visible field holds the human-readable format while the form receives the machine-readable one.

```html copy
<form>
    <input x-date name="event_date" placeholder="Event date">
    <button type="submit">Save</button>
</form>
```

---

### Time Fields

The input's authored `type` declares what the field picks. `type="time"` makes a standalone time picker — a dropdown of hour and minute columns (plus AM/PM in 12-hour locales). `type="datetime-local"` combines the calendar with a time row.

<div x-code-group>

```html copy
<!-- Time only -->
<input x-date type="time" placeholder="Pick a time">

<!-- Date + time -->
<input x-date type="datetime-local" placeholder="Pick date & time">
```

::: frame row-wrap gap-6
<input x-date type="time" placeholder="Pick a time" style="max-width: 12rem;">
<input x-date type="datetime-local" placeholder="Pick date & time" style="max-width: 18rem;">
:::

</div>

Time-only values are `HH:mm` strings; datetime values are `YYYY-MM-DDTHH:mm`. The `x-date.time` modifier on a plain input is equivalent to `type="datetime-local"`.

---

## Calendar

To author a calendar directly — without a field — place `x-date` on a container. The wrapper element determines its presentation: `<div>` renders in the page flow, `<menu popover>` anchors as a dropdown, and `<dialog popover>` opens as a modal.

<div x-code-group>

```html copy
<!-- Inline -->
<div x-date x-model="picked"></div>

<!-- Dropdown -->
<button popovertarget="cal-menu">Choose date</button>
<menu id="cal-menu" popover x-date></menu>

<!-- Dialog -->
<button popovertarget="cal-dialog">Choose date</button>
<dialog id="cal-dialog" popover x-date></dialog>
```

::: frame row-wrap gap-10
<div class="col gap-2">
<p>Inline</p>
<div x-date></div>
</div>
<div class="col gap-2">
<p>Dropdown</p>
<button popovertarget="doc-cal-menu">Choose date</button>
<menu id="doc-cal-menu" popover x-date></menu>
</div>
<div class="col gap-2">
<p>Dialog</p>
<button popovertarget="doc-cal-dialog">Choose date</button>
<dialog id="doc-cal-dialog" popover x-date></dialog>
</div>
:::

</div>

Clicking the calendar heading jumps to month and year views for fast long-range navigation, the same way native pickers do.

---

## Selection Modes

### Range

The `x-date.range` modifier selects a start and end date. Hovering previews the span before the second click commits it. The model value is a `{ start, end }` object; the form/string value is `start/end`.

<div x-code-group>

```html copy
<div x-data="{ stay: { start: '', end: '' } }">
    <input x-date.range x-model="stay" placeholder="Select a range">
</div>
```

::: frame
<div class="row-wrap items-center gap-4" x-data="{ stay: { start: '', end: '' } }">
    <input x-date.range x-model="stay" placeholder="Select a range" style="max-width: 22rem;">
    <p x-text="(stay.start || '—') + ' → ' + (stay.end || '—')"></p>
</div>
:::

</div>

For travel-booking layouts, pair ranges with a multi-month calendar — the `months` config key (1–4) lays months side by side:

<div x-code-group>

```html copy
<div x-date.range="{ months: 2 }"></div>
```

::: frame
<div x-date.range="{ months: 2 }"></div>
:::

</div>

### Multiple

The `x-date.multiple` modifier toggles any number of individual dates. The model value is an array of ISO strings; the form value is comma-separated.

<div x-code-group>

```html copy
<div x-data="{ dates: [] }">
    <div x-date.multiple x-model="dates"></div>
</div>
```

::: frame
<div class="col gap-2" x-data="{ dates: [] }">
    <div x-date.multiple x-model="dates"></div>
    <p x-text="dates.length ? dates.join(', ') : '—'"></p>
</div>
:::

</div>

---

## Configuration

Pass an object as the directive's value for reactive configuration. All keys are optional and re-evaluate like any Alpine expression.

| Key        | Type                  | Description                                                                                     |
| ---------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| `months`{copy}   | number (1–4)          | Calendar months displayed side by side. Default `1`.                                            |
| `firstDay`{copy} | string \| number      | First weekday override — a name (`'monday'`) or index (`0` = Sunday). Defaults to the locale's. |
| `min`{copy} / `max`{copy} | ISO string   | Selectable bounds. Also read from the input's native `min`/`max` attributes.                    |
| `disabled`{copy} | array \| function     | Unselectable dates — ISO strings, `{ from, to }` spans, or a `(date) => boolean` predicate.     |
| `presets`{copy}  | array                 | Quick-pick chips shown in the footer (see below).                                               |
| `now`{copy} / `clear`{copy} | boolean    | Set `false` to hide the Today/Now or Clear action. Both default `true`.                         |

<div x-code-group>

```html copy
<div x-date="{
    min: '2026-06-01',
    max: '2026-06-30',
    disabled: ['2026-06-13', { from: '2026-06-20', to: '2026-06-22' }]
}"></div>
```

::: frame
<div x-date="{ min: '2026-06-01', max: '2026-06-30', disabled: ['2026-06-13', { from: '2026-06-20', to: '2026-06-22' }] }"></div>
:::

</div>

### Presets

Each preset is a labeled value matching the selection mode: `{ label, value }` for single dates, `{ label, start, end }` for ranges, `{ label, dates }` for multiples. Because the config is a live expression, preset values can be computed.

<div x-code-group>

```html copy
<div x-date.range="{
    presets: [
        { label: 'This weekend', start: '2026-06-13', end: '2026-06-14' },
        { label: 'Next week', start: '2026-06-15', end: '2026-06-21' }
    ]
}"></div>
```

::: frame
<div x-date.range="{ months: 2, presets: [
    { label: 'This weekend', start: '2026-06-13', end: '2026-06-14' },
    { label: 'Next week', start: '2026-06-15', end: '2026-06-21' },
    { label: 'One month', start: '2026-06-01', end: '2026-06-30' }
] }"></div>
:::

</div>

---

## Keyboard

The day grid is fully keyboard-operable with a single tab stop (the selection, or today).

| Key                  | Action                          |
| -------------------- | ------------------------------- |
| `←` `→`              | Previous / next day             |
| `↑` `↓`              | Previous / next week            |
| `PageUp` `PageDown`  | Previous / next month           |
| `Home`               | Start of week                   |
| `Enter` / `Space`    | Select the focused day          |
| `Escape`             | Close the dropdown              |

---

## Localization

Calendars localize themselves from the active [locale](/docs/core-plugins/localization): month and weekday names, first day of the week, date display formats, and the 12/24-hour clock all come from `Intl`. Switching locale re-renders every calendar, with no configuration needed.

The few built-in UI strings are overridable through the universal `_ui` block — namespaced under `date` — in any [local data](/docs/core-plugins/local-data) file your project loads. Override only the keys you want; anything omitted stays in English.

<div x-code-group copy>

```json "manifest.json"
{
    "data": {
        "content": {
            "en": "/data/content.en.yaml",
            "fr": "/data/content.fr.yaml"
        }
    }
}
```

```yaml "content.fr.yaml"
_ui:
    date:
        today: Aujourd'hui
        now: Maintenant
        clear: Effacer
        previousMonth: Mois précédent
        nextMonth: Mois suivant
        time: Heure
```

</div>

| Key             | Default          | Used for                            |
| --------------- | ---------------- | ----------------------------------- |
| `today`{copy}         | Today            | Footer jump-to-today action         |
| `now`{copy}           | Now              | Time picker's current-time action   |
| `clear`{copy}         | Clear            | Footer / time picker clear action   |
| `previousMonth`{copy} | Previous month   | Header arrow label (assistive tech) |
| `nextMonth`{copy}     | Next month       | Header arrow label (assistive tech) |
| `time`{copy}          | Time             | Date+time row label                 |

Because overrides are namespaced per element, one shared `_ui` block can localize other Manifest elements too (i.e. `_ui.colorpicker`).

---

## Magic Method

Use the `$date(id)` magic method to read or change a picker from anywhere on the page. The `id` is the field's or calendar's element id. Used on its own it returns the primary value as a string.

::: frame
<div class="row-wrap items-center gap-4">
    <input id="doc-dp-magic" x-date placeholder="Choose…" style="max-width: 16rem;">
    <p x-text="$date('doc-dp-magic').iso || '—'"></p>
    <p x-text="$date('doc-dp-magic').formatted || '—'"></p>
</div>
:::

```html copy
<input id="event" x-date placeholder="Choose…">
<span x-text="$date('event').iso"></span>
<span x-text="$date('event').formatted"></span>
```

| Property                  | Returns                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `$date(id)`{copy}               | Primary value string — ISO date, `start/end`, comma list, or `HH:mm` per mode. |
| `$date(id).iso`{copy}           | Same as the primary value.                                           |
| `$date(id).formatted`{copy}     | Localized display string.                                            |
| `$date(id).date`{copy}          | The selected `Date` object (single mode).                            |
| `$date(id).range`{copy}         | `{ start, end }` ISO strings (range mode).                           |
| `$date(id).start`{copy} / `.end`{copy} | Range endpoints individually.                                  |
| `$date(id).dates`{copy}         | Array of ISO strings (multiple mode).                                |
| `$date(id).time`{copy}          | `HH:mm` string when a time is set.                                   |
| `$date(id).mode`{copy}          | `'single'`, `'range'`, or `'multiple'`.                              |

| Action                       | Effect                                      |
| ---------------------------- | ------------------------------------------- |
| `$date(id).setDate(iso)`{copy}     | Select a date programmatically.             |
| `$date(id).setTime('HH:mm')`{copy} | Set the time of day.                        |
| `$date(id).clear()`{copy}          | Clear the selection.                        |
| `$date(id).open()`{copy} / `.close()`{copy} | Open or close a field's dropdown.    |

---

## Styles

### Theme

The default calendar uses the following [theme](/docs/styles/theme) variables:

| Variable                  | Purpose                                          |
| ------------------------- | ------------------------------------------------ |
| `--color-popover-surface`{copy} | Calendar background                              |
| `--color-content-stark`{copy}   | Day numbers and primary text                     |
| `--color-content-subtle`{copy}  | Weekday labels, muted text, disabled days        |
| `--color-brand-surface`{copy} / `--color-brand-inverse`{copy} | Selected day fill and text |
| `--color-field-surface`{copy}   | Hover states and preset chips                    |
| `--color-line`{copy}            | Borders, dividers, and the today ring            |
| `--radius`{copy}                | Calendar, day, and field corner radius           |
| `--spacing-field-height`{copy}  | Header and control heights                       |
| `--transition`{copy}            | Hover and focus transitions                      |
| `--icon-previous`{copy} / `--icon-next`{copy} | Header navigation chevrons (SVG masks) |

---

### Tailwind CSS

If using Tailwind, individual fields and calendars can be customized with utility classes.

```html copy
<input x-date class="max-w-48 rounded-full" placeholder="Compact">
<div x-date class="border border-line shadow-lg"></div>
```

---

### Customization

Modify base styles with custom CSS targeting `[x-date]` (or the `.date-picker` marker class the plugin stamps on every calendar root, which also covers modified directives like `x-date.range`). The generated markup is semantic HTML, so the inner parts are plain element selectors:

| Selector                          | Part                                          |
| --------------------------------- | --------------------------------------------- |
| `header`{copy}                          | Month navigation — arrows and heading button  |
| `section`{copy}                         | One calendar month (multi-month layouts)      |
| `[role=grid] abbr`{copy}                | Weekday labels                                |
| `[role=grid] button`{copy}              | Day cells                                     |
| `[role=listbox] button`{copy}           | Month / year jump cells                       |
| `fieldset`{copy}                        | Time-of-day row (date+time)                   |
| `.time-options`{copy}                   | Hour / minute / AM-PM columns                 |
| `footer`{copy}                          | Today, presets, and Clear actions             |

Day and cell states are attributes and plain classes: `[aria-selected=true]` (selected), `[aria-current=date]` (today), `:disabled`, `.outside` (adjacent-month days), and `.range-start` / `.range-end` / `.in-range` for range spans.

```css copy
/* Rounder selected days */
[x-date] [role=grid] button[aria-selected=true],
.date-picker [role=grid] button[aria-selected=true] {
    border-radius: 50%;
}

/* Tone down the range band */
.date-picker [role=grid] button.in-range {
    background: color-mix(in oklch, var(--color-brand-surface) 15%, transparent);
}
```
