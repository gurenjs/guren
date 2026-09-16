---
'@guren/plugin-agents': patch
---

The per-instance call budget now comes from `@guren/core` (`createAgentCallBudget`) instead of a copy in this package. No behaviour change. Needs the `@guren/core` release that exports it.
