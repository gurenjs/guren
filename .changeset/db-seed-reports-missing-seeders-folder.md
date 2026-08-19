---
"@guren/orm": minor
---

Report a missing `db/seeders/` from `db:seed` as "no seeders found" instead of a database failure

`collectSeeders()` read the folder with no handling for its absence, so an app that never created `db/seeders/` had the ENOENT propagate out of `runSeeders()` into the driver's `seedDatabase()`. In `createPostgresDatabase()`, `createMySqlDatabase()` and `createSqliteDatabase()` that means `seedFailure()` wrapped it as `Failed to seed the database: ENOENT: no such file or directory, scandir '/…/db/seeders'` — a filesystem error dressed as a database failure; `createAwsDataApiDatabase()` does not wrap, so the raw ENOENT surfaced. Either way the report blamed the database for a folder that simply holds no seeders.

**Behavior change to a Stable API:** `runSeeders()` (and `loadSeeders()`) no longer reject when the directory does not exist. `runSeeders()` now resolves a `SeederRunSummary` with `seedersRan: 0` and `filesWithoutSeeder: 0`, and `loadSeeders()` returns `[]`. `db:seed` therefore reports the missing folder with the warning it already prints for an empty one — `No seeders found in db/seeders — nothing was seeded.`, pointing at `bunx guren make:seeder` — and exits 0. This matches `inspectMigrationsFolder()`, which has always reported a missing `db/migrations` as `migrationsFound: 0` rather than throwing. Callers that relied on the rejection to detect an absent folder must now check the folder themselves: the summary cannot tell them apart, since `seedersRan: 0` describes an empty folder just as well.

Only absence is softened. A path that exists but is not a directory (`ENOTDIR`), or one the process may not read (`EACCES`), still throws — both are misconfigurations, not folders holding no seeders. A folder that was never *configured* stays an error too: every driver's `seedDatabase()` still throws `No seeders folder configured. Provide "seedersFolder" when calling create<Driver>Database().` when the app passed no `seedersFolder` at all.

`examples/api` drops the workaround this cost it — it probed the folder with `existsSync` and passed `seedersFolder: undefined`, then guarded on the same flag again at boot.
