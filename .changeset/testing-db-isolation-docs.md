---
'@guren/cli': patch
---

Document SQLite test-database isolation and DB cleanup helpers in the AI agent harness template (`.claude/rules/testing.md`, shipped by `agent:init`/`agent:sync`): the scaffolded `NODE_ENV=test` branch in `config/database.ts` (default `./data/guren.test.db`, `TEST_DATABASE_URL` override, and the retrofit fix for older scaffolds that still write to the dev DB), plus guidance on `resetDatabase()`/`migrateDatabase()` vs. `useTruncateTables()`/`useDatabaseTransactions()` for cleaning up data between tests — including the explicit `DatabaseConnection` requirement and connection-identity caveat for the latter two, since Guren's SQLite adapter doesn't ship a ready-made adapter for them.
