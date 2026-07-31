---
"create-guren-app": patch
"@guren/cli": patch
---

Keep `--db mysql` scaffolds on the MySQL dialect end to end

`create-guren-app --db mysql` generated a `db/schema.ts` that imported
`mysqlTable, int, varchar, timestamp` from `@guren/orm/drizzle`. That subpath
re-exports the PostgreSQL column builders under the unqualified names, so the
MySQL `users` table was built out of a pg `timestamp`. Nothing reported it:
drizzle-kit still emitted the same MySQL DDL and the app still typechecked.

It did leak further, though. `guren add auth` and `add resource` merge new
columns into the schema's `drizzle-orm/mysql-core` import and skip any name
already visible in some import line — so with a pg `timestamp` in scope, every
later date column silently stayed on the wrong dialect too. The scaffold now
imports from `drizzle-orm/mysql-core`, matching what the patchers emit and what
the SQLite scaffold already did.

The demo-user seeder `guren add auth` writes is now dialect-aware. It used
`.onConflictDoNothing()` unconditionally, which does not exist on MySQL's query
builder — `db:seed` threw `onConflictDoNothing is not a function` on every MySQL
app. MySQL now gets the equivalent `.onDuplicateKeyUpdate()` form.
