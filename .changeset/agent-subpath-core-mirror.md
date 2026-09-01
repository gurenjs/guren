---
'@guren/core': minor
---

Mirror the new agent dispatch subpath as `@guren/core/agent`.

`export * from '@guren/server/agent'`, not an allowlist like `./lambda` and `./redis`: the server entry is already the curated one — it exists to be small and to stay free of the application graph — so restating its names here would give one surface two definitions to keep in sync.

This needs its own release even though core's `@guren/server` range already admits the version that adds the subpath: a caret range delivers a newer dependency, it does not add an export to `@guren/core`'s own `exports` map. Without a core release, `import { buildToolRequest } from '@guren/core/agent'` resolves to nothing in an installed app.
