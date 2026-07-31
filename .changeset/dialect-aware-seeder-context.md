---
"create-guren-app": patch
"@guren/core": minor
"@guren/orm": minor
"@guren/cli": patch
---

Type the seeder context against the app's own database dialect

`SeederContext.db` was hard-typed as `PostgresJsDatabase`, so every seeder was
typed against PostgreSQL no matter which database the app configured. On MySQL
and SQLite that made the seeder reject its own `db/schema.ts` — `db.insert()`
does not accept a `mysqlTable`/`sqliteTable`, and `.onDuplicateKeyUpdate()` is
not a method on the PostgreSQL insert builder at all. The runtime was always
fine: the callback receives the real database.

It was invisible in the default scaffold because `db/` was outside the app's
`tsconfig.json` `include`, but not everywhere — the API-only template already
typechecks `db/`, so `guren add auth` on a `--db mysql` API app failed
`bun run typecheck` on the seeder it had just generated.

`SeederContext` and `SeederHandler` are now generic over the database, with the
same `PostgresJsDatabase` default as before, so existing seeders keep compiling.
`PostgresSeederContext`, `MySqlSeederContext`, `SqliteSeederContext`, and
`AwsDataApiSeederContext` are exported for the other drivers that seed (D1 does
not — its `seedDatabase()` throws), and scaffolded apps re-export the one they
configured from `config/database.ts` as `AppSeederContext`:

```ts
import { defineSeeder } from '@guren/core'
import type { AppSeederContext } from '../../config/database.js'

export default defineSeeder(async ({ db }: AppSeederContext) => { /* ... */ })
```

`guren add auth` and `make:seeder` now annotate what they generate, and `db/`
joined the default template's `tsconfig.json` `include` so the generated
seeders and schema are actually typechecked. `runSeeders()` and `loadSeeders()`
accept any dialect's database, which drops the casts the MySQL, SQLite, and
Aurora Data API drivers needed.
