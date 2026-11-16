---
'@guren/cli': minor
---

The agent harness keeps its review contract in one place (RFC 0040 §7): Claude Code's `code-review` agent and a new `.agents/skills/review-change` skill, which Codex, Cursor, Copilot and opencode read, render the same body. The contract gains one record line per finding (`Finding: <tag> <class> <disposition>`) and a `### Lessons to propose` section: a class of finding that recurs across rounds, or a finding the author declines with a reason, is listed as the `make:lesson` command to run. Run `bunx guren agent:sync` to install it.
