---
description: Commit local changes and push them to the staging branch, deploying to the staging site. Website projects pre-render first. End-to-end — no mid-command prompts.
---

You are the "Publish to Staging" button. The contributor pressed it because they want their work on the staging site. Run end-to-end and report when done. **Do not ask for confirmation between steps.** Stop only on errors or guardrail violations (listed at bottom). Generate a commit message and use it directly — never ask the user to approve it mid-run.

Optional user-supplied commit message: $ARGUMENTS (if present, use verbatim instead of generating one)

## Run

1. **Read project info.** From CLAUDE.md's `## Project` block, get:
   - Default branch (fall back: `staging`)
   - Staging URL (may be `(none)` — that's fine, just omit it from the report)
   - Project type (SPA or Website — see "Project type" section)

2. **Branch check.** `git branch --show-current`. If not on the default branch, stop with: "You're on `<branch>`, not `<default>`. Switch to `<default>` first." Do not offer to switch — that's for `/sync`.

3. **Sync silently if behind.** `git fetch origin <default>`, then `git rev-list --count <default>..origin/<default>`.
   - If 0: continue.
   - If > 0: auto-handle it — stash any uncommitted work, `git pull --rebase origin <default>`, pop stash. Report briefly ("Synced N new commits from GitHub first."). Only stop if there's a real conflict (stash pop or rebase conflict) — in which case, trigger `/sync` logic for conflict resolution.

4. **Pre-render (website projects only).**
   - If **SPA** (or no declaration): skip this step.
   - If **Website**: first check whether the render is actually needed.
     - Collect changed files: `git diff --name-only HEAD` plus `git ls-files --others --exclude-standard` (covers modified, deleted, staged, untracked).
     - Render is needed **only if** at least one changed file is a source-type file **outside `/website/`**. Source-type extensions: `.html`, `.css`, `.json`, `.yaml`, `.yml`, `.csv`, `.md`.
     - If none of the changed files qualify: skip render and briefly report why (e.g. "Skipped render — no source files changed; only root-level files were touched.").
     - If render is needed: run `npx mnfst-render`. Large renders take minutes — use a background-capable approach so you can stream progress updates (e.g. "Render at 207/249. No errors. Continuing."). On non-zero exit or error output, stop and surface the error in plain terms. Do not commit.

5. **Check if anything to publish.** `git status --porcelain`.
   - If empty: "Nothing to publish — your local matches `<default>`." Stop.

6. **Generate commit message** (skip if $ARGUMENTS provided):
   - One concise imperative line reflecting the source change, not the render side-effect.
   - If multiple unrelated changes, pick the most user-visible one or describe them briefly (e.g. "Update pricing copy and remove old robots.txt").
   - Do **not** ask the user to approve. Just use it.

7. **Commit and push.**
   - `git add -A`
   - `git commit -m "<message>"`
   - `git push origin <default>`

8. **Report final state.** One block:
   - "Published to staging." If staging URL is set: "Deploying to <staging URL> in ~30–60s." Otherwise: "Your deploy host should pick this up shortly."
   - Commit message used.
   - Brief summary: N source files edited, (if website) M `/website/` files regenerated.

## Guardrails — these DO stop the command

- Not on the default branch → stop.
- `mnfst-render` errors → stop, do not commit.
- Staged files that look like secrets (`.env`, `*.key`, `*.pem`, `credentials*`) → stop, warn the user.
- Merge conflict during auto-sync → stop, hand off to `/sync` flow for resolution.
- Unexpected git state (detached HEAD, ongoing merge/rebase, wrong remote) → stop, explain.

Everything else is fire-and-forget. The contributor pressed a button — respect that.
