---
name: manifest-localize
description: Use when the contributor is working on translations or multilingual content in a Manifest project — adding a new language, translating existing copy, adding a new translatable string, or building a language switcher. Triggers on "translate this to French/Spanish/etc", "add Spanish support", "add a language", "make this multilingual", "add a translation for X", "the German copy is wrong". Manifest's docs explicitly note Claude/AI is the translation engine, so this skill leans into that. SKIP if the project has no localization set up and the contributor isn't asking to add it.
---

# Localizing content in a Manifest project

Manifest has built-in i18n via the localization plugin. Translation files are registered in `manifest.json` and accessed via `$x` like any other data source. **Manifest itself is not a translation engine — Claude is.** That makes you the right tool for the actual translation work, not just the file plumbing.

## Step 0 — find the existing setup

**Always do this first.** Open `manifest.json` and look at the `data` block for sources that look like translations. Two shapes to recognise:

```json
// CSV with multiple locales
"translations": { "locales": "/data/translations.csv" }

// JSON/YAML with one file per locale
"features": {
  "en": "/data/features.en.json",
  "fr": "/data/features.fr.json"
}
```

Also check the `<html lang="...">` attribute in `index.html` — it sets the default locale.

If no translation sources exist, the project isn't localized yet. Use the "Set up localization" recipe. Otherwise jump to the operation.

## Recipes

### Translating existing content

This is what Claude is best at. The contributor probably won't ask for it directly — they'll say "the French is missing for the new pricing copy" or "fill in Spanish for the FAQ".

1. **Open the translation file.** Identify which locale columns/files have values and which are empty for the keys in question.
2. **Translate** to the target locales. Stay faithful to:
   - **Tone** (marketing copy stays punchy; legal copy stays precise)
   - **Existing terminology** — if "Sign in" is rendered as "Connexion" elsewhere in the same project, use "Connexion" not "Se connecter". Grep first.
   - **Length** — UI copy translations should not be drastically longer than the source (it breaks layouts). Suggest a shorter alternative if the natural translation would overflow.
   - **Formality register** — match what's already used (du/Sie, tú/usted, casual/honorific Japanese forms, etc.).
3. **Note any cultural traps** to the contributor — words/idioms that don't translate cleanly, region-specific terms (US vs UK English, Latin American vs European Spanish, simplified vs traditional Chinese), or anything the brand might want to adapt rather than literal-translate.

### Adding a new language

1. **Look up which locale code is correct** — ISO 639-1 (`fr`, `es`, `ja`) for languages, optionally with region (`pt-BR`, `zh-Hant`). Check Manifest's RTL list if the language is right-to-left (`ar`, `he`, `fa`, `ur` and others) — Manifest auto-handles `dir="rtl"`.
2. **For CSV translation files**: add a column to the CSV with the locale code as the header. Fill in all rows.
3. **For JSON/YAML per-locale files**: copy an existing locale file (e.g. `features.en.json`), rename to the new locale (`features.es.json`), translate all values, register the new file in `manifest.json`:
   ```json
   "features": {
     "en": "/data/features.en.json",
     "es": "/data/features.es.json"
   }
   ```
4. **Add a language switcher** if the project doesn't already have one (see "Adding a switcher" below).
5. **Verify in the preview panel.** Switch to the new locale and confirm content renders. Test RTL layout if applicable.

### Adding a new translatable string

When the contributor adds a new piece of UI copy ("Add a 'Forgot password?' link"), the key must be added to all locale files, not hardcoded in HTML.

1. **Pick a key path** following the project's existing naming convention (e.g. `auth.forgotPassword.label`, dot-notation).
2. **Add the key** to every locale file/column with the translated value.
3. **Reference it in HTML** with `x-text="$x.translations.auth.forgotPassword.label"` (or the right source name).
4. **Don't leave any locale empty** — Manifest falls back to default locale on missing keys but the user-visible result is mixed-language UI.
5. **Translate for attributes too** — as applicable, such as `:aria` for accessibility, `:img` for localized media, or `:title`.

### Adding a switcher

```html
<button @click="$locale.set('en')">English</button>
<button @click="$locale.set('fr')">Français</button>
<button @click="$locale.set('es')">Español</button>
<!-- Or a single toggle that cycles -->
<button @click="$locale.toggle()" x-text="$locale.current"></button>
```

Or a `<select>`:
```html
<select @change="$locale.set($event.target.value)">
  <option value="en" :selected="$locale.current === 'en'">English</option>
  <option value="fr" :selected="$locale.current === 'fr'">Français</option>
</select>
```

For URL-based switching (`/fr/about`), use plain `<a href="/fr/about">` links — the router strips the locale prefix when matching `x-route`.

### Setting up localization (first time)

1. **Add the localization plugin context.** It loads automatically with the default `manifest.min.js` script — no extra setup needed in `index.html`. The plugin requires the `router` and `data` plugins, which are also default.
2. **Set the default locale** in `index.html`'s `<html lang="en">` attribute.
3. **Create a translation file.** Recommend CSV for non-technical contributors (they can edit it in Excel/Numbers/Sheets). Format:
   ```csv
   key,en,fr
   nav.home,Home,Accueil
   nav.about,About,À propos
   ```
4. **Register in `manifest.json`** under `data`:
   ```json
   { "data": { "content": { "locales": "/data/translations.csv" } } }
   ```
5. **Replace hardcoded strings** in HTML with `x-text="$x.content.nav.home"`.
6. Add a switcher.

## What not to do

- **Don't hardcode translated strings inline** — once the project is localized, every visible string should come from a translation source. But leave the default language string inline for developer visibility.
- **Don't translate UI copy literally when the natural phrasing differs** — "Sign in" in French is "Connexion" (a noun), not "Signez-vous" (a literal verb). Prefer idiom over literal.
- **Don't make up locale codes.** Use ISO 639-1; if unsure, ask.
- **Don't expand short labels into long sentences** — UI breaks. If a literal translation would overflow, propose a shorter alternative.
- **Don't translate brand names, product names, or proper nouns** unless the project explicitly does so.
- **Don't leave a locale partially translated** — fall back to default locale is silent and produces mixed-language UI in production.
- **Don't forget RTL.** If adding Arabic, Hebrew, Farsi, etc., visually verify the layout in the preview panel — `dir="rtl"` is automatic but some visual elements (icon directionality, custom spacing) may need manual fixes.

## Further reading

If the recipe above doesn't cover the situation, consult:
- Localization (URL paths, `$locale` magic, full RTL language list, language detection priority): https://manifestjs.org/docs/core-plugins/localization
- Local Data (CSV format, registration, `$x` access — same as translation files): https://manifestjs.org/docs/core-plugins/local-data
