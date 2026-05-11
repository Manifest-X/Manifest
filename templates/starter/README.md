# Manifest Starter Project

---

## 🚀 Quick Start

Run this project locally from the project root with `npx mnfst-run`, or any local server solution.

---

## 📁 Project Structure

```
project-name/
├── components/               # Reusable HTML components
│   ├── header.html           # Page header
│   ├── footer.html           # Page footer
│   └── logo.html             # Inline SVG logo
├── icons/                    # Web app (PWA) icons referenced in manifest.json
│   ├── 192x192.png           # Small icon variant
│   ├── 512x512.png           # Large icon variant
│   └── opengraph.png         # Link sharing image
├── _redirects                # SPA routing support for modern static hosts
├── favicon.ico               # Browser tab icon
├── index.html                # Rendering entry point / main page
├── LICENSE.md                # MIT License
├── locales.csv               # Translated content in English, Arabic, and Chinese
├── manifest.json             # Project & web app manifest
├── manifest.theme.css        # Project theme variables
├── prerender.mjs             # Build script for optimized websites
├── privacy.md                # Privacy policy template, required by most sites & apps
└── README.md                 # This file
```

---

## ✅ Checklist

`index.html`
- [ ] Change `<html lang="en">` to default language code
- [ ] Update head `<title>` and `<meta>` tags, and add any custom links or scripts

`manifest.json`
- [ ] Update project config properties (e.g. name, author)
- [ ] Update or remove HTML components and data sources (e.g. for localization)

**Style & Content**
- [ ] Update `manifest.theme.css` variables
- [ ] Update `logo.html`, `header.html` and `footer.html` components
- [ ] Create custom HTML components for pages, sections, etc.
- [ ] Update index.html `<body>` with top-level routes and components
- [ ] Update or remove `LICENSE.md` and `privacy.md` text for your use case

**Websites**
- [ ] Replace `favicon.ico`
- [ ] Run `npx mnfst-render` to build optimized <a href="https://manifestx.dev/publishing/websites" target="_blank">websites</a>

**Web apps**
- [ ] Replace or remove `/icons` images referenced in manifest.json

---

## 📚 Learn More

This project supports routes, components, dynamic data, localization, icons, color themes, and much more.

For comprehensive documentation visit [manifestx.dev](https://manifestx.dev).

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.