---
description: Show a plain-English summary of where the repo stands — branch, unsaved edits, and what's ready to publish or promote.
---

Give the contributor a quick "where am I?" view. Keep it short — no raw git output, just a clean summary.

## Steps

1. **Read project info** from CLAUDE.md's `## Project` block:
   - Default branch (fall back: `staging`)
   - Live branch (fall back: `production`)
   - Staging URL, Production URL (may be `(none)` — omit those lines if so)

2. Run, in parallel where possible:
   - `git branch --show-current`
   - `git status --porcelain` (count lines for modified-files count)
   - `git fetch origin <default> <live>` (silent fetch)
   - `git rev-list --left-right --count <default>...origin/<default>` (local vs remote default)
   - `git rev-list --left-right --count origin/<live>...origin/<default>` (live vs default)

3. Produce a report in this exact shape (substitute real values, omit lines that don't apply):

```
Branch:            <current-branch>
Local edits:       <N files unsaved>   ← omit if zero
Your <default>:    <N commits not yet published>   ← omit if zero
<default> → live:  <N changes ready to promote>    ← omit if zero

Staging preview:   <staging URL from CLAUDE.md>    ← omit if (none)
Live site:         <production URL from CLAUDE.md> ← omit if (none)
```

4. Then, one plain-English sentence recommending a next action:
   - Has unsaved edits → "Run `/staging` when you're ready to see these changes on the staging site."
   - Default ahead of live → "Run `/publish` when you're ready to take the staging changes live."
   - Behind origin/default → "Run `/sync` to pull in the latest from teammates."
   - Everything in sync → "All caught up."

## Guardrails

- If not on the default or live branch, call that out prominently — it usually means something has gone wrong.
- Keep output under ~12 lines total.
