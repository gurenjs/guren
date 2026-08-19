---
'@guren/core': minor
---

Export `MigrationRunSummary`, `MigrationStatusEntry`, and `SeederRunSummary` from `@guren/core`.

`@guren/core` re-exports the ORM through an explicit allowlist rather than `export *`, and these three types were never added to it. Every API that produces them already was: `runSeeders()` resolves a `SeederRunSummary`, and the `PostgresDatabase` / `MySqlDatabase` / `SqliteDatabase` / `AwsDataApiDatabase` handles resolve `MigrationRunSummary` from `migrateDatabase()` and `resetDatabase()`, `SeederRunSummary` from `seedDatabase()`, and `MigrationStatusEntry[]` from `migrationStatus()`. An application that follows the core-first rule — never import from `@guren/server` or `@guren/orm` directly — could call all of them and name none of their return types, so wrapping one in a helper with an explicit signature meant reaching past `@guren/core` for the type.

`MigrationRunSummary` and `SeederRunSummary` are new, added with the empty-folder reports for `db:migrate` and `db:seed`. `MigrationStatusEntry` has been exported from `@guren/orm` since the unified-migrations release and had the same gap the whole time; it is included here because deriving the allowlist from the ORM's export surface — rather than from the two names that prompted this — is what surfaced it. That diff is now empty: every one of the 71 types `@guren/orm` exports type-checks as an import from `@guren/core`.

Type-only, additive, no runtime change. `minor` matches how added exports are versioned here, and the bump is the point: a type-only allowlist addition ships no runtime difference, so without a changeset there is no release at all and an application's installed `@guren/core` keeps the old declarations no matter how permissive its version range is.
