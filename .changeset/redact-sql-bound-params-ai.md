---
'@guren/core': patch
'@guren/plugin-ai': patch
---

An agent whose conversation turn fails to store no longer logs the turn's text: the query error it prints has its bound parameters redacted, through the same rule `@guren/server` applies to the errors it renders and logs (published to plugins as `@guren/core/internal/redact-query-params`).
