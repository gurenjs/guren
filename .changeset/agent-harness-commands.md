---
'@guren/cli': minor
'create-guren-app': minor
---

Add `agent:init` / `agent:sync` commands and install the AI agent harness by default when scaffolding a new app.

`agent:init` installs the harness (CLAUDE.md, `.claude/` rules, skills, agents, hooks, `.mcp.json`) into any Guren app; `create-guren-app` now runs it automatically after dependency install for every blueprint. The harness wires a verification loop via `.claude/settings.json`: the `guren context` project map is injected at session start, and `guren check` re-runs after edits to routes, controllers, models, schema, or pages, feeding failures back to the agent. `agent:sync` refreshes framework-managed files without touching user-owned `CLAUDE.md`, `.mcp.json`, or `.claude/settings.json`.
