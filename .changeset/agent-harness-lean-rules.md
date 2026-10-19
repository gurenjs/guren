---
"@guren/cli": patch
---

Make the agent harness cheaper per turn. Each path-scoped rule (`orm-models`, `controllers-http`, `routes-codegen`, `testing`) is now a short core of what agents get wrong, and the rest moves to a full reference under the `guren-api` skill (`.claude/skills/guren-api/reference/*.md`), read only when a task needs it. Reading a controller or model used to attach about 7–8k tokens of rules that stayed for the rest of the session; it now attaches about 2.5–4k. `docs-and-spec.md` attaches only under `docs/**`, the implementation-plan and browser-verification command lists in `CLAUDE.md` / `AGENTS.md` point to their skills, and the MCP tool table moves to the `dev-workflow` skill.

- `testing.md` names the mistakes that cost agents a rerun: a form post that redirects answers 303 (not 201), rows are typed by the model's record type (not the class), the database is read through models (`count()` is on the query builder), and `assertInertia` lives on the request chain only.
- `guren context` (the SessionStart map) opens with a one-line note when `agent:sync` would add or replace managed harness files. `installAgentHarness()` reports those files as `writtenManaged`.
- Rule templates may use `__SKILLS_DIR__`, rendered per target like `__RULES_DIR__`.

`bunx guren agent:sync` refreshes the rules and skills of an existing app. `CLAUDE.md` and `AGENTS.md` belong to the app, so sync leaves them alone: the shorter entry document reaches new apps, and an existing one can adopt it with `bunx guren agent:init --force` (which also overwrites `.mcp.json` and `.claude/settings.json`) or by hand.
