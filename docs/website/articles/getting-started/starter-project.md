# Starter Project

Kickstart new websites and apps with a turnkey template.

---

## Install

Install the starter project locally with the `npx` command:

```bash copy
npx mnfst-starter MyProject
```

"MyProject" is the modifiable root directory title — name it after your project.

Alternatively, download the template directory from <a href="https://github.com/andrewmatlock/Manifest/tree/master/templates/starter" target="_blank">GitHub</a>.

---

## Run

<x-code-group>

```bash "From Root" copy
npx mnfst-run
```

```bash "From Subdirectory" copy
npx mnfst-run path
```

</x-code-group>

Run this project locally from the project root with `npx mnfst-run`, or any subdirectory with `npx mnfst-run path`, where "path" is the folder path. Alternatively, most local server solutions can run Manifest projects.

See [websites](/docs/publishing/websites) for deploying live to production.

---

## Capabilities

The project is provided with ready-made content for:

- Routing (page-level views & 404 content)
- Header, footer, and logo components
- Responsive layout with mobile sidebar
- Colour themes
- Localization (English, Arabic, and Chinese examples)
- Markdown article injection

---

## Files & Folders

The project begins with this folder structure for both development and deployment:

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
├── privacy.md                # Privacy policy template, required by most sites & apps
└── README.md                 # This file
```

::: brand icon="lucide:info"
The only mandatory file required is `index.html`. All other files and folders are provided for template purposes.
:::

---

## index.html

This main HTML file serves as the router's single-page application (SPA) entry point. It includes:

- **Head tags** for Manifest framework loading (from CDN), SEO, and web app configuration.
- **Component placeholders** (`<x-header>`, `<x-footer>`) of [HTML templates](/docs/core-plugins/components).
- **Routing views** (`x-route="..."`) for [URL-specific content](/docs/core-plugins/router).
- **Dynamic references** (`x-text="$x.content.page1"`) to localized [data source](/docs/core-plugins/local-data) values.

---

## manifest.json

This <a href="https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest" target="_blank">web application manifest</a> allows browsers to identify and export the website as an app to mobile and desktop devices. As a progressive web apps (PWA), your project is often more portable, scalable, and popular than traditional native apps, and can be packaged for app store distribution.

This project also uses the manifest to register its [components](/docs/core-plugins/components) and [localized](/docs/core-plugins/localiation) content, and to define `author` and `email` fields referenced by the Privacy Policy.