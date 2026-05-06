# mnfst-claude

Install Claude Code defaults (`CLAUDE.md`, slash commands, skills) for a [Manifest](https://manifestjs.org) project.

## Usage

In a Manifest project directory:

```bash
npx mnfst-claude
```

This installs:

- `CLAUDE.md` — project orientation file (in the project root)
- `.claude/launch.json` — local preview launch config
- `.claude/commands/` — slash commands: `/sync`, `/staging`, `/publish`, `/status`, `/preview`
- `.claude/skills/` — recipe skills for adding pages, components, theme tweaks, and data sources
- `.claude/.mnfst-claude.json` — hash manifest used to detect future customizations

## Re-running

By default, re-running `npx mnfst-claude` updates files that match the previously shipped version and **preserves any files you've edited since**. This means you can safely re-run to pull in updates without losing your customizations.

To wipe and reinstall everything (including your edits), use:

```bash
npx mnfst-claude --force
```

## What you should fill in

Open `CLAUDE.md` and fill in the `## Project` block at the top — project name, staging URL, production URL, and (if different from defaults) the branch names.
