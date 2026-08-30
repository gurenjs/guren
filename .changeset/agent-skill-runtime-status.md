---
'@guren/cli': patch
---

Correct the agent-interface skill's account of what ships. It told every scaffolded app that `expose`, `approval`, and `redact` were "recorded now; acted on when those surfaces ship" — `@guren/plugin-mcp` honours all three today, hiding unexposed tools, refusing approval-required ones fail-closed, and masking the named fields in the audit events. Two things in that table genuinely have not shipped — `expose.webMcp` and the approval *queue* — and the skill now names those two instead of disclaiming the whole set.
