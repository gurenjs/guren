---
'@guren/orm': patch
---

Fixed a database connection leak under `bun --hot`. Each hot reload re-runs the module graph in the same process, so `createPostgresDatabase()`, `createMySqlDatabase()`, and `createSqliteDatabase()` opened a fresh client while the one the previous evaluation opened stayed connected with nothing left to close it — roughly one leaked connection per reload, which exhausts a default Postgres `max_connections` over a long dev session. The factories now park their teardown on a `globalThis` registry (the same approach `Application.listen()` already uses for the Bun and Vite dev servers) and close the previous client before serving from the new one.

This only applies under `bun --hot`, and a handle is only replaced by one created from the same source location against the same database. Factories written side by side — one pool for web requests and another for background jobs, say — keep their own connections, and nothing is ever torn down automatically in production, tests, CLI commands, or serverless.

As part of this, `closeDatabase()` on a SQLite database now actually closes the underlying `bun:sqlite` handle instead of only dropping its reference.
