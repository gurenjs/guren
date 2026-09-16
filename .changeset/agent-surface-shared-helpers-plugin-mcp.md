---
'@guren/plugin-mcp': patch
---

The `audit` option and its file sink now come from `@guren/core` (`AgentAuditConfig`, `resolveAgentAuditSink`) instead of a copy in this package. No behaviour change. Needs the `@guren/core` release that exports them.
