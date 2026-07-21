---
"@guren/create-app": minor
---

Scaffolded apps (`default` and `api-only` blueprints) no longer route test runs into the development SQLite database. `config/database.ts`'s filename resolver now checks `NODE_ENV === 'test'` (which `bun test` sets automatically) and points at `./data/guren.test.db` instead of `./data/guren.db`, unless `DATABASE_URL` is explicitly set — which still wins.

Also add `@guren/testing` to both templates' `devDependencies`, matching the version format already used for other `@guren/*` packages — previously a fresh scaffold had no path to `TestApp`/controller testing without a manual `bun add -d @guren/testing` first.
