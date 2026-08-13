---
'@guren/cli': minor
---

`agent:sync` now reports files left behind in framework-managed directories when a canonical rule or skill is renamed or removed — including the stale `.cursor/rules/guren-*.mdc` and `.github/instructions/guren-*.instructions.md` copies Cursor and Copilot keep auto-loading — and `agent:sync --prune` deletes them. Without `--prune`, sync never deletes anything, so user files under colliding names stay safe by default.
