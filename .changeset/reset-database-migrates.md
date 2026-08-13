---
'@guren/orm': minor
'@guren/cli': patch
---

`resetDatabase()` now re-applies migrations after dropping, matching `guren db:reset`

The Postgres, MySQL, SQLite, and Aurora Data API factories dropped every table
and stopped there, so the next query failed with `relation "posts" does not
exist` — far from the reset that caused it. `resetDatabase()` now migrates
afterwards and leaves a migrated database, the same end state the CLI's
`db:reset` produces.

Suites already following the documented reset-then-migrate pattern keep
working: the second `migrateDatabase()` call sees an up-to-date tracker and
no-ops. D1 is unchanged — its resets go through wrangler.
