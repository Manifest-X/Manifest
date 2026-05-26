# mnfst-export

Batch and CI exports for Manifest projects — same six formats as the runtime `x-export` directive (PDF, PNG, JPEG, WebP, CSV, JSON) plus a CI-only `rss` format for blog feeds.

## Usage

```bash
# One-off
npx mnfst-export --pdf --path /reports/q3 --target "#report"

# Whole project (reads manifest.export.routes from manifest.json)
npx mnfst-export

# Data source as CSV
npx mnfst-export --csv --path /admin/customers --source customers
```

## manifest.json

```json
{
  "export": {
    "output": "exports",
    "routes": [
      { "path": "/reports/q3", "format": "pdf", "target": "#report" },
      { "path": "/customers",  "format": "csv", "source": "customers" },
      { "path": "/blog",       "format": "rss", "source": "posts", "map": { "link": "slug" } }
    ]
  }
}
```

See `npx mnfst-export --help` for all flags.

## Requirements

Install `puppeteer` in the project that runs the export — it's a peer dependency:

```bash
npm i -D puppeteer
```
