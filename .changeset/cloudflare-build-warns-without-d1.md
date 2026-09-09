---
"@guren/plugin-cloudflare": patch
---

Warn when the database config never calls `createD1Database()`

The Cloudflare build stubs every SQL client and `bun:sqlite`, since D1 is the
only database Workers can reach, but it never checked whether the app's
`config/database.ts` (or `db/config.ts`) actually calls `createD1Database()`. A
config calling only `createSqliteDatabase()` or `createPostgresDatabase()` built
clean and threw on the deployed worker's first query.

The build now reads the config the same way the Lambda build does and warns,
naming the file and the factories it found, when none of them is D1. A config
naming D1 beside another factory (switching at runtime) passes, and a config the
scan cannot read stays silent: a name scan cannot see a factory reached
indirectly, so this is advice rather than a gate.
