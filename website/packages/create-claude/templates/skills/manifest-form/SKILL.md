---
name: manifest-form
description: Use when the contributor wants to add or edit a form in a Manifest project — contact form, signup, login, settings panel, search box, anything with inputs the user fills out. Triggers on "add a contact form", "build a signup", "make a search box", "let users submit X", "add a comment field". Manifest auto-styles raw form HTML; the skill covers structure, validation, submission, and feedback patterns. For sign-in/auth flows specifically, use manifest-appwrite if available.
---

# Building a form in Manifest

Manifest auto-styles `<form>`, `<input>`, `<textarea>`, `<select>`, `<button>`, checkboxes, radios, and switches. You don't need a CSS framework or component library — write semantic HTML and it looks right.

The harder part is **submission and feedback**, which Manifest doesn't handle out of the box. You need to wire it up with Alpine.

## Recipe

### 1. Structure the form with semantic HTML

Wrap inputs in `<label>` for accessibility — Manifest's pre-styling assumes this nesting:

```html
<form @submit.prevent="submit()">
  <label>
    Your name
    <input type="text" name="name" required>
  </label>
  <label>
    Email
    <input type="email" name="email" required>
  </label>
  <label>
    Message
    <textarea name="message" rows="4" required></textarea>
  </label>
  <button type="submit" class="brand">Send</button>
</form>
```

Notes:
- `<form>` lays children out as a vertical flex column with gaps automatically.
- Color classes work on `<button>`: `brand`, `accent`, `positive`, `negative`. Sizes: `sm`, `lg`.
- For inline checkbox + label: `<label><input type="checkbox" name="agree"> I agree</label>`.
- For radios with the same `name`, they auto-group.
- For grouped accordion-style toggles (one open at a time), use `<details name="group">`.

### 2. Bind state with Alpine

Use `x-data` on the `<form>` for local state:

```html
<form x-data="{ form: { name: '', email: '', message: '' }, sending: false }"
      @submit.prevent="sending = true; await submit(form); sending = false">
  <label>Name<input type="text" x-model="form.name" required></label>
  <label>Email<input type="email" x-model="form.email" required></label>
  <label>Message<textarea x-model="form.message" required></textarea></label>
  <button type="submit" class="brand" :disabled="sending" x-text="sending ? 'Sending…' : 'Send'"></button>
</form>
```

`x-model` two-way-binds the input to the data. `:disabled` and dynamic text on the button gives loading feedback.

### 3. Pick a submission destination

Manifest does not have a built-in form-submission endpoint. Pick one based on the project:

- **Appwrite** — if Appwrite is configured in `manifest.json`, submit via the Appwrite SDK (`$x.collectionName.$create({...})` for databases, or `$auth.signup()` for auth flows). Use the **manifest-appwrite** skill.
- **A third-party form service** (Formspree, Netlify Forms, Web3Forms, etc.) — submit via `fetch()` to their endpoint. Read their docs for the URL and required fields.
- **A custom API** — submit via `fetch()`. The API must accept POST and return JSON.
- **mailto:** — for the simplest possible contact form, the form's `action` can be `mailto:hello@example.com`. Browser-dependent and not great UX.

If unsure which to use, ask the contributor: "Where should this form send to? Options: your Appwrite project, a service like Formspree, or your own API."

### 4. Show feedback

After submission, push a UI state like some confirmation text or a toast:

```html
@submit.prevent="
  try { await submit(form); $el.querySelector('[x-toast]')?.click() }
  catch(e) { /* show error toast */ }
"
...
<button type="button" hidden x-toast.positive="'Thanks — we\\'ll be in touch.'"></button>
```

Or use a route navigation or `<dialog popover>` for richer success states (e.g. a confirmation screen).

### 5. Validate

Use native HTML validation (`required`, `type="email"`, `pattern`, `minlength`, `maxlength`) — they integrate with Manifest's input styling. Add custom validation in the `@submit` handler when needed:

```html
@submit.prevent="
  if (!form.email.includes('@')) { errorMsg = 'Email looks wrong'; return; }
  await submit(form);
"
```

### 6. Verify in the preview panel

- Tab through fields — focus styles should be visible.
- Submit empty — required fields should block.
- Submit valid — feedback should appear.
- Test on mobile width via `preview_resize` if it's a public form.

## What not to do

- **Don't wrap inputs in extra `<div>`s for styling.** The `<label><input></label>` nesting is what Manifest's CSS targets.
- **Don't reinvent inputs.** A custom `<div role="checkbox">` won't get Manifest's styling; use `<input type="checkbox">`.
- **Don't put credentials, payment info, or sensitive PII in client-side form state without a real backend.** Form state lives in the browser; submitting to a no-backend endpoint exposes it.
- **Don't try to POST to a registered API data source.** The data plugin is read-only for APIs (today). Use `fetch()` directly, or use Appwrite.
- **Don't `event.preventDefault()` only sometimes.** Either use `@submit.prevent` and handle submission yourself, or let the form submit natively — don't mix.

## Further reading

If the recipe above doesn't cover the situation, consult:
- Forms (auto-styling and structure): https://manifestjs.org/docs/elements/forms
- Inputs (color modifiers, sizes, label nesting): https://manifestjs.org/docs/elements/inputs
- Dialogs (for richer success/confirmation states): https://manifestjs.org/docs/elements/dialogs
- Toasts (notification feedback after submit): https://manifestjs.org/docs/elements/toasts
- Tooltips (helpers on hover): https://manifestjs.org/docs/elements/tooltips
