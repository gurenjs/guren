---
'@guren/orm': patch
---

Fixed a database connection leak under `bun --hot`. Each hot reload re-runs the module graph in the same process, so `createPostgresDatabase()`, `createMySqlDatabase()`, and `createSqliteDatabase()` opened a fresh client while the one the previous evaluation opened stayed connected with nothing left to close it — roughly one leaked connection per reload, which exhausts a default Postgres `max_connections` over a long dev session. The factories now park their teardown on a `globalThis` registry (the same approach `Application.listen()` already uses for the Bun and Vite dev servers) and close the previous client before serving from the new one.

This only applies under `bun --hot`. A handle is identified by the file that built it and the database it points at, so it is replaced only by a later evaluation of that same file. Nothing is ever torn down automatically in production, tests, CLI commands, or serverless. The one thing to know: two handles built in a single file against a single database — separate pools for web requests and background jobs, say — share that identity under `--hot`, so the second replaces the first. Give them their own module to keep them apart.

As part of this, `closeDatabase()` on a SQLite database now actually closes the underlying `bun:sqlite` handle instead of only dropping its reference.
