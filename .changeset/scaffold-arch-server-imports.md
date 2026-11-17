---
'create-guren-app': patch
'@guren/cli': patch
---

The scaffolded `guren.arch.ts` now fails `guren check` when a file under `resources/js/` imports a file under `app/`, `config/`, `db/`, `routes/` or `src/` as a value. A page importing a Resource class instead of its type used to put the class and its imports in the client bundle with no finding. `import type` still passes. The agent harness's UI rule says the same.
