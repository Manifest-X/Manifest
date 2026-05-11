# mnfst-types

Generate a `manifest.d.ts` file for a Manifest project so editors and AI coding assistants understand the shape of `$x.<source>`, `$route`, `$modify`, and the other Manifest magic globals.

## Usage

From the root of a Manifest project (next to `manifest.json`):

```bash
npx mnfst-types
```

This writes `manifest.d.ts` in the current directory. Re-run it whenever you add or change a data source in `manifest.json`.

## Options

```
--manifest <path>   Path to manifest.json (default: ./manifest.json)
--out <path>        Output .d.ts path (default: ./manifest.d.ts)
--init              Also write a baseline jsconfig.json (only if missing)
-h, --help          Show usage
```

## How it works

1. Reads `manifest.json` and walks each entry under `data`.
2. For local CSV / JSON / YAML sources, samples the first ~50 rows to infer field types.
3. For Appwrite-table sources, generates a row interface with `$id` plus an extension point.
4. For Appwrite-bucket sources, types the source as `ManifestBucketSource`.
5. Combines the inferred row types with the static ambient declarations and writes a single `manifest.d.ts`.

The generated file's static portion (magic globals, query operators, source-state flags) is fixed; only the section between `// AUGMENTATION:start` and `// AUGMENTATION:end` is regenerated on subsequent runs.

## Companion: `manifest.json` JSON Schema

For autocomplete and validation in `manifest.json` itself, add a `$schema` reference at the top of the file:

```json
{
    "$schema": "https://manifestx.dev/manifest.schema.json",
    "name": "My Project",
    "data": { ... }
}
```

VS Code and most JSON-aware editors will fetch and apply the schema automatically.
