---
"@guren/orm": minor
"@guren/cli": minor
---

Report an empty seeders folder from `db:seed` instead of "Database seeders executed."

`runSeeders()` loops over zero seeders without complaint, so the CLI reported success for a run that wrote nothing. The scaffolded `db/seeders/` ships holding only `.gitkeep`, which makes this the next green line after an empty `db/migrations` on the fresh-app path — the same defect class, one step further from the cause.

`runSeeders()` and every driver's `seedDatabase()` now resolve a `SeederRunSummary` (`seedersFolder`, `seedersRan`, `filesWithoutSeeder`), and `db:seed` warns `No seeders found in db/seeders — nothing was seeded.`, pointing at `bunx guren make:seeder`. A folder whose files exported no seeder gets the warning without that hint and is told what a seeder module must export instead — those files exist, they are just in a shape the loader skips. `db:reset --seed` and `db:fresh --seed` report the same run, where the ✔ claimed a database that had just been emptied and not repopulated; when both halves came back empty the migration warning wins, since seeding a schema that was never re-applied could not have worked anyway. All three carry `seedersRan` and `filesWithoutSeeder` in their `--json` output whenever the app's ORM reports them.

The command still exits 0 — it is a diagnostic, not a failure — and a `config/database.ts` whose seed function reports nothing keeps the previous message. A missing seeders folder still throws as before, rather than being softened into this warning.
