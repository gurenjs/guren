---
'create-guren-app': minor
---

The scaffolder now asks which AI coding agents to set up the agent harness for (Claude Code, Codex, Cursor, GitHub Copilot, OpenCode) and installs the matching files via `guren agent:init --target`. Answer non-interactively with `--agents codex,cursor`, or skip the harness entirely with `--agents none`; non-interactive environments keep the claude-only default.
