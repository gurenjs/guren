---
'@guren/cli': patch
---

The harness `code-review` agent runs on `opus` at `effort: high` instead of `sonnet`. `agent:sync` replaces `.claude/agents/code-review.md`, a local edit to it included, and lists it as replaced; `agent:sync --dry-run` shows that first.
