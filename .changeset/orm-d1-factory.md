---
'@guren/orm': minor
'@guren/core': minor
---

Added `createD1Database` — the Cloudflare D1 factory (RFC 0003 Part 2), alongside the postgres/mysql/sqlite factories and re-exported from `@guren/core`. It takes a deferred `binding` resolver (`binding: () => getWorkersEnv<Env>().DB` — bindings reach runtime-portable app code via the plugin's write-once holder, populated on the first request) and wires `drizzle-orm/d1` into the ORM adapter. D1 speaks the SQLite dialect, so schemas written for `createSqliteDatabase` port unchanged.

The operational surface is deliberately different from the other factories: `migrateDatabase()`, `seedDatabase()`, `resetDatabase()`, and `migrationStatus()` throw with guidance instead of executing — wrangler owns the D1 migration lifecycle (`wrangler d1 migrations apply` over the same drizzle-kit-generated SQL files, `migrations_dir` pointing at `db/migrations`). The drizzle-kit SQL format contract (statement-breakpoint separators, filename ordering, idempotent re-apply) is covered by an opt-in end-to-end test against wrangler's local D1 (`GUREN_TEST_WRANGLER=1`).
