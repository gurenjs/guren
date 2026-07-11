---
"@guren/orm": patch
---

Load the `postgres` and `mysql2` driver packages lazily. Importing `@guren/orm` previously executed `import postgres from 'postgres'` at module load, so any environment without the optional peer installed (SQLite-only apps that prune unused drivers, or the CLI resolved outside an app) crashed with "Cannot find package 'postgres'" before any code ran. Drivers now load on first use of `createPostgresDatabase()` / `createMySqlDatabase()`, with a clear install hint when missing.
