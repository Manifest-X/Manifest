---
description: Pull the latest changes from the staging branch on GitHub, safely handling any in-progress local work.
---

You are helping a (possibly non-technical) contributor sync their local copy with the latest on the default branch (per CLAUDE.md — usually `staging`). Speak plainly — do not dump raw git output unless something goes wrong.

## Steps

1. **Determine the default branch.** Read CLAUDE.md's `## Project` block for "Default branch". Fall back to `staging` if not set.

2. **Check current branch.** Run `git branch --show-current`.
   - If not on the default branch: tell the user which branch they're on and offer to switch: "You're on `<branch>`, not `<default>`. The team works from `<default>`. Switch now?" If yes, `git checkout <default>`. If they have uncommitted changes, carry them across with `git checkout` (git will refuse if there's a conflict — handle that case below).

3. **Check for uncommitted local work.** Run `git status --porcelain`.
   - If there are changes, tell the user plainly: "You have unsaved edits in [N files]. I'll set them aside while I pull the latest, then put them back." Then run `git stash push -u -m "auto-stash before /sync"`. Remember you stashed so you can restore.

4. **Fetch from GitHub.** Run `git fetch origin <default>`.

5. **Compare local to remote.** Use `git rev-list --left-right --count <default>...origin/<default>`.
   - If `0 0`: "Already up to date — nothing new on `<default>`."
   - If `N 0` (local ahead only): "You have N commit(s) not yet published. Run `/staging` when ready."
   - If `0 N` (remote ahead only): fast-forward with `git merge --ff-only origin/<default>`. Then summarize: "Pulled N new commit(s). Files updated: …" (list from `git diff --stat <default>@{1} <default>` — keep it short).
   - If `M N` (both diverged): `git pull --rebase origin <default>`. If rebase succeeds, summarize as above. If conflicts, see step 7.

6. **Restore stashed work** if you stashed in step 3: `git stash pop`.
   - If pop succeeds cleanly: "Your edits are back."
   - If pop has conflicts: go to step 7.

7. **Conflict handling (plain English).** If `git pull --rebase` or `git stash pop` produces conflicts:
   - List the conflicted files.
   - For each, read the file, find the `<<<<<<<` / `=======` / `>>>>>>>` markers, and explain in human terms what changed on each side.
   - Offer the user three choices per file: keep yours, take theirs, or combine — and apply their choice.
   - If it's clearly a trivial combine (e.g. additions in different regions), propose a merged version directly and ask for confirmation.
   - Never run `git rebase --abort` or `git checkout --theirs/--ours` without telling the user what it means in plain terms first.

8. **Done.** Report final state: current branch, whether edits were restored, and a one-line summary of what was pulled.

## Guardrails

- Never force-push, never discard the user's local edits without explicit OK.
- If anything unexpected happens (detached HEAD, wrong remote, merge in progress), stop and explain — don't try clever recovery.
