# __APP_TITLE__

The canonical agent guide for this project is @AGENTS.md — everything about
the project structure, commands, architecture, and testing lives there.

## Claude Code Specifics

The manual steps in AGENTS.md's "Session Workflow" section are automated for
Claude Code, so you can skip them:

- A `SessionStart` hook (`.claude/settings.json`) injects the `guren context`
  project map, ending with the "Guren API Signatures" digest — those
  signatures are already in your context before you write any code.
- A `PostToolUse` hook (`.claude/hooks/check-after-edit.ts`) re-runs
  `guren check` after edits to routes, controllers, models, schema, or pages
  and reports failures back immediately.
- The verified API rules load automatically based on the files you are
  editing (glob-scoped) from `.claude/rules/*.md` — the same content as
  `.agents/rules/`.

Framework-managed files (`.claude/rules`, `.claude/skills`, `.claude/agents`,
`.claude/hooks`, `.agents/`) can be refreshed anytime with
`bunx guren agent:sync`.
