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
--ci                Also write .github/workflows/types.yml (only if missing)
--check             Exit 1 if the output is out of date; write nothing
--tsc               Type-check the scripts the page loads (paths from the import map)
-h, --help          Show usage
```

## Type checks without a build

```bash
npx mnfst-types --tsc
```

Type-checks the scripts `index.html` and the manifest's component files load
(and everything they import), plus the project's `.d.ts` files. The config is
built on every run: paths come from the page's import map, so adding an alias
never needs a config change. No folder layout is assumed. A project `jsconfig.json` or `tsconfig.json` is
extended — its own options and paths win.

`--init` writes a `jsconfig.json` so editors show the same errors as you type;
run it again after changing the import map to add new aliases to it. `--ci`
adds a GitHub Actions workflow running `--check` and `--tsc` on every push. See
https://manifestx.dev/docs/framework/getting-started/type-checks.

## How it works

1. Reads `manifest.json` and walks each entry under `data`.
2. For local CSV / JSON / YAML sources, samples the first ~50 rows to infer field types.
3. For Appwrite-table sources, rows accept any field until the project declares their type in `ManifestRows`.
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
