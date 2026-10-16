---
"@guren/orm": minor
"@guren/core": minor
"@guren/server": minor
"@guren/cli": patch
---

The introspection manifest gains a `database` section (RFC 0033 §3): the dialect and whether the database is `local`, `remote` or `unknown`, read without connecting and never including the connection string. Every built-in factory (`createPostgresDatabase`, `createMySqlDatabase`, `createSqliteDatabase`, `createD1Database`) has a `describe(context?)` that resolves its connection setting under the app's env; `ConfigurableDatabase` declares it as optional, so a custom adapter without it leaves the section unverified. Anything not shown to be on a loopback host or a local file reads as `unknown`, never `local`.
