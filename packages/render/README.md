# mnfst-render

Static renderer for Manifest projects.

## Usage

```bash
npx mnfst-render --root .
```

The command reads `manifest.json` and writes rendered pages to `manifest.render.output` (default `website`).

## Concurrent renders

Only one render may write an output directory at a time. While running, a render holds `<output>.mnfst-lock` (next to the output directory) recording its PID, host, start time, and command. A second render against the same output exits immediately with an error naming the running render.

A lock left behind by a process that no longer exists is taken over automatically. To take over a lock regardless, pass `--force-lock`; the render that lost the lock will not replace the output when it finishes.
