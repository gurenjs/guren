This project ships with an agent harness wired into `.claude/settings.json`:
a `SessionStart` hook injects the `guren context` project map, and a
`PostToolUse` hook (`.claude/hooks/check-after-edit.ts`) re-runs `guren check`
after edits to routes, controllers, models, schema, or pages and reports
failures back immediately. The injected map ends with a "Guren API Signatures"
digest of the ORM, controller, and testing APIs — those signatures are already
in your context before you write any code. Framework-managed files
(`.claude/rules`, `skills`, `agents`, `hooks`) can be refreshed anytime with
`bunx guren agent:sync`.

Detailed, verified API rules live in `.claude/rules/*.md` and load automatically
based on the files you are editing (glob-scoped).
