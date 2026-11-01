---
'@guren/server': minor
'@guren/core': minor
'@guren/plugin-ai': patch
'@guren/cli': patch
---

The bound-parameter redaction `@guren/server` applies to the errors it renders and logs is published to the framework's own packages as `@guren/server/internal/redact-query-params` (re-exported as `@guren/core/internal/redact-query-params`). Through it, an agent whose conversation turn fails to store, an eval case whose setup or teardown throws, a console command that fails, and a `guren` command that fails on a query no longer print the bound values of that query.
