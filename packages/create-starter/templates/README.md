# Template Info

This cloneable project provides essential scaffolding for a website or app. Visit <a href="https://manifestx.dev/docs/getting-started/starter-project" target="_blank">manifestx.dev</a> for more.

---

## CLI

In a parent directory:
- `npx mnfst-starter <Project Name>` — install this template with any project name.

From the project root:
- `npx mnfst-run` — run the project on a local server.
- `npx mnfst-test` — run a test suite to identify production issues.
- `npx mnfst-render` — prerender the project to a default `/website` output directory, optimized for SEO/AEO.

---

## Project Structure

```
Project Name/
├── assets/                   # Visual files
│   ├── fonts                 # Web fonts
│   │   └── Inter.woff2
│   └── icons                 # Web app icons               
│       ├── 192x192.png
│       └── 512x512.png
├── components/               # HTML components
│   ├── header.html
│   ├── footer.html
│   └── logo.html
├── _redirects                # SPA routing support for modern static hosts
├── favicon.ico               # Browser tab icon
├── index.html                # Rendering entry point / main page
├── LICENSE.md                # MIT License
├── locales.csv               # Translated content in English, Arabic, and Chinese
├── manifest.json             # Project & web app manifest
├── manifest.theme.css        # Project theme variables
├── privacy.md                # Privacy policy template, required by most sites & apps
└── README.md                 # This file
```

---

## License

This project is open source under MIT License for any use.