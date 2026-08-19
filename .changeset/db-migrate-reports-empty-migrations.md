---
"@guren/orm": minor
"@guren/cli": minor
"create-guren-app": patch
---

Report an empty migrations folder from `db:migrate` instead of "Database migrations completed."

`migrateDatabase()` returns before it touches a connection when the folder holds no drizzle-kit migrations, so the CLI reported success for a run that applied nothing and created no database. On a fresh app that is the last green line before `db:seed` fails on a missing table, far from the cause.

The driver handles now resolve a `MigrationRunSummary` (`migrationsFolder`, `migrationsFound`, `looseSqlFiles`) and `db:migrate` warns `No migrations found in db/migrations — nothing was applied.`, pointing at `bun run db:make`. A folder holding loose `.sql` files gets the warning without the `db:make` hint — those migrations exist, they are just in a shape the drizzle migrator skips, which the ORM already explains. The command still exits 0, and a `config/database.ts` whose migration function reports nothing keeps the previous message.

`create-guren-app` also names `db:make` in the closing reminder it prints after scaffolding authentication, the one step of that sequence the reminder left out.
