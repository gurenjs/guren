---
'create-guren-app': patch
---

Restore the `guren make:module` note in the scaffolded `drizzle.config.ts`.
The comment explaining that `make:module` re-exports each
`modules/<name>/db/schema.ts` into `db/schema.ts` — and that `schema` also
accepts an array of paths/globs — lived only in the `templates/default` and
`templates/api-only` copies of the file, which `applyDatabaseConfig`
overwrites unconditionally, so no scaffolded app ever received it. It now
ships in all three `templates/database/<driver>/drizzle.config.ts` variants,
and the two dead template copies are removed.
