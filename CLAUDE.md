# Manifest framework — repo notes for Claude

Source repo for the `mnfst` framework and its sibling npm packages
(`mnfst-run`, `mnfst-render`, `mnfst-publish`, `mnfst-types`, `mnfst-starter`).
Source of truth is `src/`; `lib/` is **built output** (`npm run build`);
`packages/*` are synced from `src/` and published from there. The default
branch is `master`.

## Working with git & other sessions

Multiple Claude sessions and teammates work this repo at the same time, and
diverging, unmerged branches have caused real pain here — duplicated or
stranded fixes, and messy reconciliations. Keep everyone converged:

- **Default to committing on `master`.** Fetch/pull at the start of work and
  again before committing; commit in small steps and **push promptly** so your
  work never strands another session.
- **Don't create branches casually.** A short-lived feature/release branch is
  fine when it's a *deliberate, discrete* piece of work — but merge it back to
  `master` and delete it promptly; never leave it to diverge. Do not spin up a
  branch just out of the generic "branch before committing" habit, and never
  switch branches in a shared checkout without saying so (it yanks the working
  tree out from under other sessions and any preview).
- **Respect other sessions' work.** Uncommitted changes you didn't make belong
  to another live session — never stash, `reset`, discard, or branch around
  them; build on top, or leave them be.
- **Never force-push; never `--no-verify` or skip hooks.** For anything unusual
  (diverged branches, a merge in progress, unexpected remote state), stop and
  ask before recovering — don't improvise destructive fixes.

## Building & releasing

- `npm run build` regenerates `lib/` from `src/` and re-syncs `packages/*`.
- Publish with the `release:*` scripts (`release`, `release:render`,
  `release:publish`, …). They derive the next version from npm
  (`scripts/release-bump.mjs`), so a stale local checkout can't collide with an
  already-published version.

## Dev-server previews (one server, never stale)

Andrew reviews work at **http://localhost:5055** — the app-managed server that
serves `src/` from THIS checkout. Divergent previews are forbidden:

- **This checkout's `master` must track `origin/master`.** After any worktree
  merge lands on origin, `git pull --ff-only` here promptly — a stale checkout
  makes 5055 lie to whoever is reviewing.
- **Never leave commits or edits stranded here.** Work in worktrees, merge to
  origin, pull back. Unpushed local commits on this checkout caused a released
  npm package whose source wasn't in the repo.
- **Ad-hoc servers from worktrees are for automated verification only**: random
  high port, kill the process AND remove the worktree in the same session.
  Never point Andrew at one.
- `serve.mjs` refuses a second instance per directory — if it reports one
  already running, use that instance rather than another port.
