---
"@guren/plugin-cloudflare": minor
---

Export `isWorkersRuntime()` from `@guren/plugin-cloudflare/env`. Every app that picks D1 over a local driver needs the workerd check, and the package's own README used it in the R2 snippet without an import — so each app hand-wrote it in `config/database.ts`. It ships from the same import-free subpath as `getWorkersEnv`, and the README's snippets now import both from there.
