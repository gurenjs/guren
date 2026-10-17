---
"@guren/cli": patch
---

The `code-review` agent `agent:init` and `agent:sync` install for Claude Code now reviews in rounds: every finding names its line, what reaches it and what goes wrong, and is tagged Important, Nit (three at most, none on a re-review) or Pre-existing; the report opens with the count and has no strengths section. A re-review reads only what changed since the previous one, reports each earlier finding as fixed or still open, and after the third round with an Important finding still open hands the change to a person. The `plan-implement` skill passes the agent the commit a task starts from and, on a re-review, the round number, the previous review's commit and its findings.
