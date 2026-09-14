---
"@guren/cli": patch
---

`make:feature --prototype` reports the fixture it appended to as updated rather than created, since `guren add prototype` created it. At promotion, the migration step no longer tells you to run `db:make` when a migration in the drizzle `out` folder already creates the table; it names that migration and points at `db:status` for whether it is applied.
