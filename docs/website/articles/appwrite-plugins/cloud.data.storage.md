# Storage

Upload, view, and download files from Appwrite storage buckets.

---

## Appwrite Configuration

In your Appwrite project's **Storage** dashboard, create a bucket.

::: frame
<img src="/assets/examples/appwrite.storage.webp" alt="Appwrite storage buckets"/>
:::

Within a bucket you can see its files and configure settings like allowed file types, maximum file size, encryption, and antivirus scanning.

::: frame
<img src="/assets/examples/appwrite.bucket.webp" alt="Appwrite bucket contents"/>
:::

::: brand icon="lucide:info"
In a bucket's **Settings** tab, ensure any permissions required by your frontend user experience (**Create**, **Read**, **Update**, **Delete**) are checked.
:::

---

## Register Storage Buckets

Register storage buckets in your `manifest.json` under the `data` property, same as [local data files](/docs/core-plugins/local-data) and [database tables](/docs/appwrite-plugins/databases). Include the `appwriteBucketId` value provided by Appwrite.

```json "manifest.json" copy
{
    "data": {
        "assets": {
            "appwriteBucketId": "your-bucket-id"
        }
    },
    "appwrite": {
        "projectId": "your-project-id",
        "endpoint": "your-API-endpoint"
    }
}
```

In this example, the "assets" data source name is arbitrary, used to later reference bucket content in the frontend. An Appwrite data source will automatically reference the `appwrite` property for credentials.

Alternatively, credentials can be added directly to a data source:

```json "manifest.json" copy
{
    "data": {
        "assets": {
            "projectId": "your-project-id",
            "endpoint": "your-API-endpoint",
            "appwriteBucketId": "your-bucket-id"
        }
    }
}
```

### Scope

Scoping automatically filters file access by user or team, ensuring users only see files they're permitted to access. Configure scope in `manifest.json`:

```json "manifest.json" copy
{
    "data": {
        "assets": {
            "appwriteBucketId": "your-bucket-id",
            "scope": "user"
        }
    }
}
```

Scope options are:

| Scope | Description | Permission Used |
|-------|-------------|-----------------|
| `"user"` | Single user's files | User permissions |
| `"team"` | Current team's files | Team permissions |
| `"teams"` | All teams user belongs to | Team permissions |
| `["user", "team"]` | User's files OR current team's files | User OR team permissions |
| `["user", "teams"]` | User's files OR any team's files | User OR team permissions |

Scope filters are applied when listing files, ensuring users only see files they have permission to access based on Appwrite's permission system.

When using `["user", "team"]` scope, files are shown for the current user OR the current team. If no team is selected (`$auth.currentTeam`), only user-scoped files will display. Use `"teams"` (plural) instead of `"team"` (singular) to query all teams the user belongs to, not just the current team.

::: brand icon="lucide:info"
All interactive examples below require you to be logged into a dummy account via the [users](/docs/appwrite-plugins/users) article. The files you generate below use the `team` scope.
:::

---

## Display & Manage Files

Storage buckets work identically to local data sources and database tables. Access files using the `$x` magic method and perform all CRUD operations:

::: frame col
<!-- Manage files -->
<div x-data="{ 
    permanentTeam: null
}"
x-effect="(async () => {
    if (permanentTeam || !$auth.teams || $auth.teams.length === 0) return;
    for (const team of $auth.teams) {
        if (await $auth.isTeamImmutable(team.$id)) {
            permanentTeam = team;
            $auth.currentTeam = team;
            $auth.viewTeam(team);
            break;
        }
    }
})()">
    
    <div class="col">
        <!-- Upload -->
        <div class="row-wrap gap-2 mb-2">
            <label role="button" class="flex-1">
                <input type="file" @change="if ($event.target.files.length > 0) { $x.assets.$create($event.target.files[0]).then(() => { $event.target.value = ''; }).catch(err => alert('Upload failed: ' + err.message)); }" accept="*/*" />
                <span>Choose File</span>
            </label>
        </div>
        
        <!-- List with actions -->
        <template x-for="file in $x.assets" :key="file.$id">
            <div class="row gap-2 py-1 items-center border-t border-line">
                <div class="flex-1 col gap-1">
                    <figcaption class="text-sm font-semibold" x-text="file.name || 'Unnamed file'"></figcaption>
                    <small class="text-muted" x-text="file.$formattedSize"></small>
                </div>
                <button class="sm" @click="$x.assets.$openUrl(file.$id)" x-icon="lucide:external-link" title="View"></button>
                <button class="sm" @click="$x.assets.$duplicate(file.$id)" x-icon="lucide:copy" title="Duplicate"></button>
                <button class="sm" @click="if (confirm('Delete ' + file.name + '?')) { $x.assets.$delete(file.$id); }" x-icon="lucide:trash" title="Delete"></button>
            </div>
        </template>
        <small x-show="!$x.assets || $x.assets.length === 0" class="text-muted">No files yet</small>
    </div>
</div>
<small x-show="!$auth.teams || $auth.teams.length === 0" class="text-muted">No teams available</small>
:::

<x-code-group numbers copy>

```html "All"
<div>
    <!-- Upload file -->
    <label role="button">
        <input type="file" @change="if ($event.target.files.length > 0) { $x.assets.$create($event.target.files[0]).then(() => { $event.target.value = ''; }); }" accept="*/*" />
        <span>Upload File</span>
    </label>
    
    <!-- List files -->
    <template x-for="file in $x.assets" :key="file.$id">
        <div class="row gap-2 items-center">
            <span x-text="file.name"></span>
            <button @click="$x.assets.$openUrl(file.$id)" x-icon="lucide:external-link"></button>
            <button @click="$x.assets.$duplicate(file.$id)" x-icon="lucide:copy"></button>
            <button @click="$x.assets.$delete(file.$id)" x-icon="lucide:trash"></button>
        </div>
    </template>
</div>
```

```html "Display" copy
<!-- Display all files -->
<template x-for="file in $x.assets" :key="file.$id">
    <div>
        <p x-text="file.name"></p>
        <small x-text="file.$formattedSize"></small>
    </div>
</template>

<!-- Display single file -->
<div x-show="$x.assets && $x.assets.length > 0">
    <p x-text="$x.assets[0].name"></p>
    <img :src="$x.assets[0].$url" :alt="$x.assets[0].name" />
</div>

<!-- Display image files only -->
<template x-for="file in $x.assets" :key="file.$id">
    <img x-show="file.$isImage" :src="file.$url" :alt="file.name" />
</template>
```

```html "Upload" copy
<!-- Basic upload -->
<label role="button">
    <input type="file" @change="if ($event.target.files.length > 0) { $x.assets.$create($event.target.files[0]); }" accept="*/*" />
    <span>Upload File</span>
</label>

<!-- Upload with custom file ID -->
<label role="button">
    <input type="file" @change="if ($event.target.files.length > 0) { $x.assets.$create($event.target.files[0], 'custom-file-id'); }" accept="*/*" />
    <span>Upload with Custom ID</span>
</label>

<!-- Upload multiple files -->
<label role="button">
    <input type="file" multiple @change="Array.from($event.target.files).forEach(file => { $x.assets.$create(file); });" accept="*/*" />
    <span>Upload Multiple</span>
</label>

<!-- Upload with progress -->
<label role="button">
    <input type="file" @change="if ($event.target.files.length > 0) { 
        $x.assets.$create($event.target.files[0], null, null, (progress) => { 
            console.log('Upload progress:', progress); 
        }); 
    }" accept="*/*" />
    <span>Upload with Progress</span>
</label>
```

```html "View & Download" copy
<!-- Get file URL for viewing -->
<button @click="const url = await $x.assets.$url(file.$id); window.open(url);">
    View File
</button>

<!-- Open file in new tab -->
<button @click="$x.assets.$openUrl(file.$id)">
    Open File
</button>

<!-- Get download URL -->
<button @click="const url = await $x.assets.$download(file.$id); window.open(url);">
    Download File
</button>

<!-- Open download in new tab -->
<button @click="$x.assets.$openDownload(file.$id, file.name)">
    Download
</button>

<!-- Preview image with options -->
<button @click="$x.assets.$openPreview(file.$id, { width: 800, height: 600 })">
    Preview Image
</button>
```

```html "Duplicate" copy
<!-- Duplicate file (auto-generates name with "copy" suffix) -->
<button @click="$x.assets.$duplicate(file.$id)">
    Duplicate
</button>

<!-- Duplicate with custom name -->
<button @click="$x.assets.$duplicate(file.$id, { newName: 'Copy of ' + file.name })">
    Duplicate with Custom Name
</button>

<!-- Duplicate with custom file ID -->
<button @click="$x.assets.$duplicate(file.$id, { 
    newName: file.name + ' Copy',
    newFileId: 'custom-file-id'
})">
    Duplicate with Custom ID
</button>
```

```html "Delete" copy
<!-- Delete single file -->
<button @click="if (confirm('Delete ' + file.name + '?')) { $x.assets.$delete(file.$id); }">
    Delete
</button>

<!-- Delete multiple files -->
<button @click="$x.assets.$delete([file1.$id, file2.$id])">
    Delete Selected
</button>
```

</x-code-group>

Storage buckets automatically sync changes in realtime across all active sessions. When one user uploads or deletes a file, all other users see the change immediately without page refresh.

**Method details:**

| Method | Parameters | Description |
|--------|------------|-------------|
| `$create(file, fileId?, permissions?, onProgress?)` | `file` (File object), `fileId` (string, optional), `permissions` (array, optional), `onProgress` (function, optional) | Upload a new file. Returns uploaded file. If `scope` is configured, permissions are automatically set based on user/team |
| `$duplicate(fileId, options?)` | `fileId` (string or object with `$id`), `options` (object, optional) | Duplicate a file. Options: `newName`, `newFileId`. Returns duplicated file. If `newName` is not provided, the file name will be "{originalName} copy" |
| `$delete(fileIdOrArray)` | `fileIdOrArray` (string, object with `$id`, or array) | Delete file(s). Returns deleted file(s) |
| `$url(fileId, token?)` | `fileId` (string or object with `$id`), `token` (string, optional) | Get file view URL. Returns URL string |
| `$download(fileId, token?)` | `fileId` (string or object with `$id`), `token` (string, optional) | Get file download URL. Returns URL string |
| `$preview(fileId, options?, token?)` | `fileId` (string or object with `$id`), `options` (object, optional), `token` (string, optional) | Get file preview URL (images only). Options: width, height, quality, output, etc. Returns preview URL string |
| `$openUrl(fileId, token?)` | `fileId` (string or object with `$id`), `token` (string, optional) | Open file view URL in new tab |
| `$openDownload(fileId, filename?, token?)` | `fileId` (string or object with `$id`), `filename` (string, optional), `token` (string, optional) | Open file download URL in new tab |
| `$openPreview(fileId, options?, token?)` | `fileId` (string or object with `$id`), `options` (object, optional), `token` (string, optional) | Open file preview URL in new tab |

---

## Link Files to Database Entries

Files can be automatically linked to database entries when uploaded. Configure the relationship in `manifest.json`:

```json "manifest.json" copy
{
    "data": {
        "assets": {
            "appwriteBucketId": "your-bucket-id",
            "belongsTo": {
                "table": "projects",
                "id": "$entryId",
                "fileIdsColumn": "fileIds"
            }
        },
        "projects": {
            "appwriteTableId": "your-table-id",
            "storage": {
                "assets": "fileIds"
            }
        }
    }
}
```

When a file is uploaded with an `entryId` parameter, it's automatically added to that entry's `fileIds` array:

```html
<!-- Upload file and link to project entry -->
<button @click="$x.assets.$create(file, null, null, { entryId: project.$id, table: 'projects' })">
    Upload to Project
</button>
```

Alternatively, link files manually after upload:

```html
<!-- Link file to entry after upload -->
<button @click="
    $x.assets.$create(file).then(uploadedFile => {
        const currentFileIds = project.fileIds || [];
        $x.projects.$update(project.$id, { 
            fileIds: [...currentFileIds, uploadedFile.$id] 
        });
    });
">
    Upload and Link
</button>
```

See [databases](/docs/appwrite-plugins/databases#storage-file-references) for more details on file references.

---

## Properties & Methods

### File Properties

Each file includes standard Appwrite properties plus computed properties:

| Property | Type | Description |
|----------|------|-------------|
| `$id` | string | Unique identifier |
| `name` | string | File name |
| `size` | number | File size in bytes |
| `$formattedSize` | string | Human-readable size (e.g., "2.5 MB") |
| `mimeType` | string | MIME type (e.g., "image/png") |
| `$createdAt` | string | Upload timestamp (ISO format) |
| `$updatedAt` | string | Last update timestamp (ISO format) |
| `$url` | string | View URL |
| `$isImage` | boolean | `true` if image file |
| `$thumbnailUrl` | string | Thumbnail URL (images only) |

```html
<!-- Access file properties -->
<div x-text="file.$id"></div>              <!-- Unique identifier -->
<div x-text="file.name"></div>             <!-- File name -->
<div x-text="file.size"></div>             <!-- File size in bytes -->
<div x-text="file.$formattedSize"></div>   <!-- Human-readable size (e.g., "2.5 MB") -->
<div x-text="file.mimeType"></div>         <!-- MIME type (e.g., "image/png") -->
<div x-text="file.$createdAt"></div>       <!-- Upload timestamp (ISO) -->
<div x-text="file.$updatedAt"></div>       <!-- Last update timestamp (ISO) -->
<div x-text="file.$url"></div>             <!-- View URL -->
<div x-text="file.$isImage"></div>         <!-- Boolean: true if image file -->
<div x-text="file.$thumbnailUrl"></div>    <!-- Thumbnail URL (images only) -->
```

---

### State Properties

Check data source loading state, errors, and readiness:

| Property | Type | Description |
|----------|------|-------------|
| `$loading` | boolean | Indicates if data is currently being loaded |
| `$error` | string \| null | Error message if an operation failed (null if no error) |
| `$ready` | boolean | Indicates if data has been loaded at least once |

```html
<!-- Loading state -->
<small x-show="$x.assets.$loading">Loading files...</small>

<!-- Error state -->
<small x-show="$x.assets.$error" x-text="$x.assets.$error" class="text-error"></small>

<!-- Ready state -->
<small x-show="$x.assets.$ready && !$x.assets.$loading">
    Files loaded: <b x-text="$x.assets.length"></b>
</small>
```

---

### CRUD Methods

<x-code-group>

```html "$create" copy
<!-- Upload single file -->
<label role="button">
    <input type="file" @change="if ($event.target.files.length > 0) { $x.assets.$create($event.target.files[0]); }" accept="*/*" />
    <span>Upload</span>
</label>

<!-- Upload with custom file ID -->
<label role="button">
    <input type="file" @change="if ($event.target.files.length > 0) { $x.assets.$create($event.target.files[0], 'custom-id'); }" accept="*/*" />
    <span>Upload with ID</span>
</label>

<!-- Upload with progress callback -->
<label role="button">
    <input type="file" @change="if ($event.target.files.length > 0) { 
        $x.assets.$create($event.target.files[0], null, null, (progress) => { 
            console.log('Progress:', progress + '%'); 
        }); 
    }" accept="*/*" />
    <span>Upload with Progress</span>
</label>
```

```html "$duplicate" copy
<!-- Duplicate file (auto-generates name) -->
<button @click="$x.assets.$duplicate(file.$id)">
    Duplicate
</button>

<!-- Duplicate with custom name -->
<button @click="$x.assets.$duplicate(file.$id, { newName: 'Copy of ' + file.name })">
    Duplicate with Name
</button>

<!-- Duplicate with custom file ID -->
<button @click="$x.assets.$duplicate(file.$id, { 
    newName: file.name + ' Copy',
    newFileId: 'custom-id'
})">
    Duplicate with ID
</button>
```

```html "$delete" copy
<!-- Delete single file -->
<button @click="if (confirm('Delete ' + file.name + '?')) { $x.assets.$delete(file.$id); }">
    Delete
</button>

<!-- Delete multiple files -->
<button @click="$x.assets.$delete([file1.$id, file2.$id])">
    Delete Selected
</button>
```

</x-code-group>

---

### View & Download Methods

<x-code-group>

```html "$url" copy
<!-- Get view URL -->
<button @click="const url = await $x.assets.$url(file.$id); console.log(url);">
    Get View URL
</button>

<!-- Get view URL with token -->
<button @click="const url = await $x.assets.$url(file.$id, token); console.log(url);">
    Get URL with Token
</button>
```

```html "$download" copy
<!-- Get download URL -->
<button @click="const url = await $x.assets.$download(file.$id); console.log(url);">
    Get Download URL
</button>

<!-- Get download URL with token -->
<button @click="const url = await $x.assets.$download(file.$id, token); console.log(url);">
    Get Download URL with Token
</button>
```

```html "$preview" copy
<!-- Get preview URL (images only) -->
<button @click="const url = await $x.assets.$preview(file.$id, { width: 800, height: 600 }); console.log(url);">
    Get Preview URL
</button>

<!-- Get preview with all options -->
<button @click="const url = await $x.assets.$preview(file.$id, { 
    width: 800, 
    height: 600, 
    quality: 90,
    output: 'webp'
}); console.log(url);">
    Get Preview with Options
</button>
```

```html "$openUrl" copy
<!-- Open file in new tab -->
<button @click="$x.assets.$openUrl(file.$id)">
    View File
</button>
```

```html "$openDownload" copy
<!-- Open download in new tab -->
<button @click="$x.assets.$openDownload(file.$id, file.name)">
    Download File
</button>
```

```html "$openPreview" copy
<!-- Open preview in new tab -->
<button @click="$x.assets.$openPreview(file.$id, { width: 800, height: 600 })">
    Preview Image
</button>
```

</x-code-group>

**View & Download Methods:**

| Method | Parameters | Description |
|--------|------------|-------------|
| `$url(fileId, token?)` | `fileId` (string or object with `$id`), `token` (string, optional) | Get file view URL. Returns URL string |
| `$download(fileId, token?)` | `fileId` (string or object with `$id`), `token` (string, optional) | Get file download URL. Returns URL string |
| `$preview(fileId, options?, token?)` | `fileId` (string or object with `$id`), `options` (object, optional), `token` (string, optional) | Get file preview URL (images only). Options: width, height, quality, output, etc. Returns preview URL string |
| `$openUrl(fileId, token?)` | `fileId` (string or object with `$id`), `token` (string, optional) | Open file view URL in new tab |
| `$openDownload(fileId, filename?, token?)` | `fileId` (string or object with `$id`), `filename` (string, optional), `token` (string, optional) | Open file download URL in new tab |
| `$openPreview(fileId, options?, token?)` | `fileId` (string or object with `$id`), `options` (object, optional), `token` (string, optional) | Open file preview URL in new tab |

---

## Image Handling

Image files receive special handling with automatic thumbnail generation and preview support:

```html
<!-- Display image with thumbnail -->
<template x-for="file in $x.assets" :key="file.$id">
    <div x-show="file.$isImage">
        <img :src="file.$thumbnailUrl" :alt="file.name" />
        <p x-text="file.name"></p>
    </div>
</template>

<!-- Display full-size image -->
<img :src="file.$url" :alt="file.name" />

<!-- Preview with custom dimensions -->
<button @click="$x.assets.$openPreview(file.$id, { 
    width: 1200, 
    height: 800,
    quality: 95,
    output: 'webp'
})">
    High Quality Preview
</button>
```

Image preview options:

| Option | Type | Description |
|--------|------|-------------|
| `width` | integer | Resize width (0-4000) |
| `height` | integer | Resize height (0-4000) |
| `quality` | integer | Image quality (0-100) |
| `output` | string | Format: `jpeg`, `jpg`, `png`, `gif`, `webp` |
| `gravity` | string | Crop gravity: `center`, `top-left`, `top`, `top-right`, `left`, `right`, `bottom-left`, `bottom`, `bottom-right` |
| `borderWidth` | integer | Border width in pixels (0-100) |
| `borderColor` | string | Border color (HEX without #) |
| `borderRadius` | integer | Border radius in pixels (0-4000) |
| `opacity` | number | Opacity (0-1, PNG only) |
| `rotation` | integer | Rotation in degrees (-360 to 360) |
| `background` | string | Background color (HEX without #, PNG only) |

---

## Next Steps

See [databases](/docs/appwrite-plugins/databases) for managing database entries and linking files to entries.
