---
'@guren/plugin-ai': patch
---

The `audit` option, its file sink and the call budget now come from `@guren/core` (`AgentAuditConfig`, `resolveAgentAuditSink`, `createAgentCallBudget`) instead of copies in this package. No behaviour change. Needs the `@guren/core` release that exports them.
