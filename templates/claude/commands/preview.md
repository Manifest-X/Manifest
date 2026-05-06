---
description: Start the local preview server (npx mnfst-run) so you can see your changes live in the browser.
---

You are starting the local Manifest preview for the contributor. They want to see the site running on their machine so they can eyeball changes as they edit. Run end-to-end and report when ready. **Do not ask for confirmation.**

## Run

1. **Check whether a preview is already running.** If the Claude Code preview panel reports an active server (or `lsof -iTCP:5001 -sTCP:LISTEN` returns anything), report: "Preview is already running at http://localhost:5001 — open the panel to see it." Stop.

2. **Start the server.** Run `npx mnfst-run` as a background process. The first run on a new machine may take a few seconds while `npx` resolves the package; that's normal.

3. **Confirm it's up.** Wait briefly, then check `lsof -iTCP:5001 -sTCP:LISTEN` (or equivalent). If listening, report: "Preview is up at http://localhost:5001." If not listening within ~10 seconds, surface whatever the server printed in plain terms (e.g. "The server failed to start — port 5001 may already be in use by another app.").

4. **Tell the user what to do next.** One sentence: "Open http://localhost:5001 in your browser, or use the preview panel. Edits to source files refresh the page automatically."

## Guardrails

- If port 5001 is in use by something other than Manifest, do not kill it — report the conflict and ask the user how they want to proceed.
- If `npx mnfst-run` errors out, surface the error in plain terms. Don't retry silently.
