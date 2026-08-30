---
'@guren/cli': patch
---

Correct the agent-interface skill's account of what ships. It told every scaffolded app that `expose`, `approval`, and `redact` were "recorded now; acted on when those surfaces ship" — `@guren/plugin-mcp` honours all three today, hiding unexposed tools, refusing approval-required ones fail-closed, and masking the named fields in the audit events. Only the approval queue is still ahead of its metadata, and the skill now says exactly that.
