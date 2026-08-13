---
'@guren/cli': minor
---

`guren agent:init` now installs the agent harness for multiple agents via `--target` (claude, codex, cursor, copilot, opencode, or `all`). Non-Claude agents get `AGENTS.md` plus the shared `.agents/rules/` and `.agents/skills/` trees they read natively; Codex and OpenCode also get their MCP client config (`.codex/config.toml` / `opencode.json`), left untouched with a printed snippet when the file already exists. `guren agent:sync` refreshes every installed family it detects on disk.
