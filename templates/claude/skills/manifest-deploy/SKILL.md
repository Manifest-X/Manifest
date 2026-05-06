---
name: manifest-deploy
description: Use when the contributor wants to set up production hosting for a Manifest project — connect a host (Appwrite Sites, Netlify, Cloudflare Pages, etc.), configure build/output, set production environment variables, wire up a custom domain, or decide whether the site should be installable as a PWA. Triggers on "deploy this site", "connect to Netlify/Cloudflare/Appwrite Sites", "set up production", "configure the build", "add a custom domain", "make this installable as an app", "remove the PWA / install prompt". This is one-time setup; for the everyday publishing flow use `/staging` and `/publish`. SKIP for routine commits and content edits.
---

# Wiring up production deployment

The `/staging` and `/publish` slash commands assume the host is already connected to the repo. This skill covers the one-time setup at the host, plus a few related project-shape decisions (PWA install behaviour, custom domains).

## Pick a host

Most common paths for Manifest projects:

### Appwrite Sites (Manifest's default suggestion)

In the Appwrite console:
1. **Sites → Create site → Connect the GitHub repo**
2. Set the production branch to `production`; create a second site connected to the `staging` branch for the staging URL
3. **Important:** Appwrite Sites can't run `npx mnfst-render` itself (Puppeteer dependencies aren't available in the build environment). For website projects, **render locally** with `npx mnfst-render` and commit `/website/` to the deploy branch. Set the site's output directory to `website`. For SPAs, leave build/output blank — Appwrite serves the repo root.
4. Add `.env` variables in **Site Settings → Environment variables**

### Netlify

1. **New site → Import from Git → choose the repo**
2. **Build command:** `npx mnfst-render` (website projects) or blank (SPA)
3. **Publish directory:** `website` (website) or `.` (SPA)
4. Create a second site connected to the `staging` branch for the staging URL
5. Add env vars in **Site settings → Environment variables**

### Cloudflare Pages

1. **Workers & Pages → Create → Connect to Git**
2. Build command and output directory same as Netlify
3. **Production branch:** `production`. Preview deployments are auto-created for non-production branches, so `staging` gets its own URL automatically — no second site needed.
4. Env vars in **Settings → Environment variables**

### Other (GitHub Pages, Vercel)

Work but less natural fit. GitHub Pages can't easily do a separate staging-branch deploy without custom Actions YAML. Vercel is React-oriented though static deploys work fine. Suggest only if the contributor specifically wants them; Cloudflare Pages or Netlify are usually the smoother path for a multi-branch Manifest setup.

## After wiring up

1. **Fill in URLs in CLAUDE.md.** Open `CLAUDE.md` and put the Staging URL and Production URL in the `## Project` block so `/status`, `/staging`, and `/publish` can include them in their output.
2. **If the host can't run `npx mnfst-render`** (e.g. Appwrite Sites): render locally with `npx mnfst-render`, commit `/website/`, then push. Add a note to the project README so the next contributor knows.
3. **Production env vars.** Anything in your local `.env` that the production deploy needs (Appwrite project IDs for prod, third-party API keys, etc.) must be entered in the host's UI. The repo's `.env` is gitignored and never reaches the host.
4. **Dev keys do not belong in production.** `APPWRITE_DEV_KEY` exists to bypass rate limits in development — production should run without it (or with a properly scoped production key, not the dev key).
5. **Custom domains** are configured at the host (Site Settings → Domains on most providers). Manifest itself doesn't care about the domain. After connecting one, update `manifest.json`'s `live_url` and CLAUDE.md's Production URL.

## PWA installability

`manifest.json` is also a [standard Web App Manifest](https://developer.mozilla.org/en-US/docs/Web/Manifest) — that's where the file's name comes from. By default, Manifest projects are installable as PWAs (browsers will offer "Add to Home Screen" or "Install App") because the starter `manifest.json` contains the standard fields:

- `name`, `short_name`, `description`
- `start_url`, `scope`, `display` (`standalone` makes the installed app launch without browser chrome)
- `background_color`, `theme_color`
- `orientation`
- `icons` array (192×192 and 512×512 minimum for installability)

This is desirable for most projects. But for a marketing site or simple landing page where you don't want install prompts, you can strip these fields from `manifest.json`.

**Two checks before stripping:**

1. **Are any of the fields referenced as data?** Grep for `$x.manifest.` in HTML and components:
   ```
   rg '\$x\.manifest\.' --type=html
   ```
   Starter projects commonly reference `$x.manifest.name` (OG title), `$x.manifest.live_url` (canonical URL, OG URL), and `$x.manifest.author` (meta author). Don't strip a field that's still referenced — either replace those references with hardcoded values or move them to a different data source first.
2. **Are there PWA-related tags in `<head>`?** Look for `<meta name="theme-color">` and the `<link rel="manifest">` line. The `<link rel="manifest">` should stay (Manifest's data plugin needs it to load `manifest.json` as a config file too); the `<meta name="theme-color">` can go if you don't care about the address-bar color.

Even for non-PWA projects, keep `name`, `description`, `start_url`, and `live_url` — they're often referenced by SEO tags, sitemap generation, and Manifest's own auto-detection logic.

## What not to do

- **Don't commit a dev key to git or paste one into the host's production env vars.** Production should use real production credentials — typically a server-scoped key with the actual permissions the production environment needs, not a rate-limit-bypass key.
- **Don't try to make `npx mnfst-render` run on Appwrite Sites.** Render locally, commit `/website/`, deploy.
- **Don't push directly to the live branch to deploy.** Use `/publish`. Direct pushes bypass the eyeball-staging step and any branch protection.
- **Don't strip PWA fields without grepping for `$x.manifest.` first.** Hidden breakage waiting to happen — the page renders fine in dev, then OG previews go blank in production.
- **Don't manually maintain `sitemap.xml` or `robots.txt`** — `mnfst-render` generates them from routes and `prerender.liveUrl`. Manual edits are overwritten on next render.

## Further reading

If the recipe above doesn't cover the situation, consult:
- Websites publishing (full prerender, sitemap, robots, deployment): https://manifestjs.org/docs/publishing/websites
- Web App Manifest spec (PWA fields): https://developer.mozilla.org/en-US/docs/Web/Manifest
