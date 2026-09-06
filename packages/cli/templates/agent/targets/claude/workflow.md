This project ships with an agent harness wired into `.claude/settings.json`:
a `SessionStart` hook injects the `guren context` project map, and a
`PostToolUse` hook (`.claude/hooks/check-after-edit.ts`) re-runs `guren check`
after edits to routes, controllers, models, schema, or pages, and runs oxlint on
the edited file when the app has an `.oxlintrc.json` (`bunx guren add lint`
writes one; warnings are reported too), feeding findings back immediately. A
`Stop` hook (`.claude/hooks/gate-on-stop.ts`) runs `guren gate` when you finish a
turn with uncommitted changes: codegen, typecheck, lint, `check`, `audit`, and
the test suite, the same stages CI runs. If any stage fails, the stop is blocked
once and the findings come back to you — fix them in the same turn rather than
leaving them for CI. Run `bunx guren gate` yourself before declaring a change
done. The injected map ends with a "Guren API Signatures"
digest of the ORM, controller, and testing APIs — those signatures are already
in your context before you write any code. Framework-managed files
(`.claude/rules`, `skills`, `agents`, `hooks`) can be refreshed anytime with
`bunx guren agent:sync`.

Detailed, verified API rules live in `.claude/rules/*.md` and load automatically
based on the files you are editing (glob-scoped).
