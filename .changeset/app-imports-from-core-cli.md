---
'@guren/cli': patch
---

The agent harness (`rules/orm-models.md`, the `guren-api` skill), the API digest in `guren context` and the `guren doctor` database hint now point at `@guren/core` for models, database factories and `ModelNotFoundException`, matching what `make:model`, `make:seeder` and `make:auth` already generate. `@guren/orm/drizzle/<dialect>` stays the import for `db/schema.ts`. Run `guren agent:sync` to refresh an installed harness.
