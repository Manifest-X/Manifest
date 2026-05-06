# Appwrite Setup

Use <a href="https://appwrite.io/" target="_blank" rel="noopener">Appwrite</a> to turn Manifest projects into production-ready applications.

---

## Overview

Appwrite provides turnkey backend infrastructure, available <a href="https://github.com/appwrite/appwrite" target="_blank">open source</a> or <a href="https://appwrite.io/" target="_blank">cloud hosted</a> with a generous free tier. Together with Manifest you can quickly generate feature-complete applications including user authentication, databases, and storage.

---

## Appwrite Setup

Establish a project with any name and region in <a href="https://appwrite.io/" target="_blank" rel="noopener">Appwrite</a>. Once created you'll access the project console:

::: frame
<img src="/assets/examples/appwrite.overview.webp" alt="Appwrite project"/>
:::

---

### Credentials

Your Manifest project will need the Appwrite project's <b>Project ID</b> and <b>API Endpoint</b> to connect. Get them from the Appwrite project's general <b>Settings</b>, under API credentials:

::: frame
<img src="/assets/examples/appwrite.credentials.webp" alt="Appwrite credentials"/>
:::

---

### Dev Key

An optional <b>Dev Key</b> can also be used during Manifest project development to bypass Appwrite's rate limits. It should not be included in production. Get one from <b>Overview</b> > <b>Dev keys</b>:

::: frame
<img src="/assets/examples/appwrite.devkey.webp" alt="Appwrite dev key"/>
:::

---

## Manifest Setup

### Scripts

Add the Appwrite SDK and `manifest.js` scripts to the HTML head. `manifest.json` is also required to register Appwrite credentials and data sources.

Appwrite plugins can be loaded in two ways: explicitly via the `data-plugins` attribute, or automatically when Appwrite credentials are declared in `manifest.json`. When auto-detected, only the relevant Appwrite plugins are loaded based on the credentials and data sources present. The supporting core data plugin will also be loaded whether or not it's declared.

<x-code-group>

```html "Auto Detection" copy
<!-- Meta -->
<link rel="manifest" href="/manifest.json">

<!-- Scripts -->
<script src="https://cdn.jsdelivr.net/npm/appwrite@latest"></script>
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"></script>
```

```html "Selective" copy
<!-- Meta -->
<link rel="manifest" href="/manifest.json">

<!-- Scripts -->
<script src="https://cdn.jsdelivr.net/npm/appwrite@latest"></script>
<script src="https://cdn.jsdelivr.net/npm/mnfst@latest/lib/manifest.min.js"
    data-plugins="appwrite-auth,appwrite-data,appwrite-presence"></script>
```

</x-code-group>

---

### manifest.json

The Project ID and API Endpoint are public and safe to commit client-side — Appwrite enforces project-level access via its own permissions. The Dev Key is sensitive (it bypasses rate limits) and must not be committed. Reference it via `${APPWRITE_DEV_KEY}` and put the value in a gitignored `.env` file. This pattern is also supported for the Project ID and API Endpoint if desired.

Add the Appwrite project credentials detailed [above](#credentials) to `manifest.json`, under an `appwrite` property. These credentials are used by any other objects in the manifest that reference Appwrite, like database or storage sources.

<x-code-group>

```json "manifest.json" copy
{
    "appwrite": {
        "projectId": "your-project-id",
        "endpoint": "your-API-endpoint",
        "devKey": "${APPWRITE_DEV_KEY}"
    }
}
```

```env ".env" copy
APPWRITE_DEV_KEY=your-appwrite-dev-key
```

</x-code-group>

Alternatively, credentials can be added directly into specific [database](/docs/appwrite-plugins/databases) or [storage](/docs/appwrite-plugins/storage) sources, declared within the `data` object.

```json "manifest.json" copy
{
    "data": {
        "projects": {
            "projectId": "your-project-id",
            "endpoint": "your-API-endpoint",
            "appwriteDatabaseId": "your-database-id",
            "appwriteTableId": "your-table-id"
        },
        "assets": {
            "projectId": "your-project-id",
            "endpoint": "your-API-endpoint",
            "appwriteBucketId": "your-bucket-id"
        },
        "other-content": "/local/whatever.csv"
    }
}
```

If credentials are declared in both `appwrite` and `data` objects, the `data` credentials take precedence for their own items.

---

## Next Steps

After a successful setup above, your Manifest project should be paired with your Appwrite project(s). Proceed to configuring:

- [Users](/docs/appwrite-plugins/users) or [Teams](/docs/appwrite-plugins/teams)
- [Databases](/docs/appwrite-plugins/databases) or [Storage](/docs/appwrite-plugins/storage)