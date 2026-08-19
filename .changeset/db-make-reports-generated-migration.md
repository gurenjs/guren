---
"@guren/cli": minor
---

Report what `db:make` actually generated instead of an unconditional "Migration generated."

`drizzle-kit generate` exits 0 whether it wrote a migration or printed "No schema changes, nothing to migrate.", and the CLI reported ✔ off that exit code. Paired with the empty-folder warning `db:migrate` now prints, a user whose `db/schema.ts` has no pending changes got a loop with nothing in it explaining why: warning → `db:make` → ✔ → `db:migrate` → the same warning.

`makeMigration()` now diffs the migrations folder around the child process and resolves that folder the same three ways it decides drizzle-kit's arguments — an explicit `--out`, the `out` the drizzle config declares, or the default. `db:make` names the migration it generated, and warns `No migration generated in db/migrations — db/schema.ts has no changes since the last one.` when there was none, pointing at the schema rather than back at `db:make`. The command still exits 0.

The folder is reported only when it was positively resolved: a drizzle config that declares no `out`, or one that throws on import, leaves the previous message rather than naming a folder drizzle-kit may not have written to.

`makeMigration()` now resolves to a `MakeMigrationResult` rather than `void`, and that type is exported alongside `MakeMigrationOptions` so a caller can name what it receives.
