---
"@guren/orm": patch
---

Reject a connection URI where the SQLite driver expects a file path

`createSqliteDatabase()` treats its `filename` as a path, and creates the
directory above it with `mkdir -p`. So a connection string handed to a SQLite
app did not fail — it *succeeded*. `postgres://guren:guren@localhost:54322/guren`
became a real `postgres:/guren:guren@localhost:54322/` directory tree with a
real database inside it, and `db:migrate` and `db:status` then agreed with each
other about that stray file. The only symptom was that the database the app
actually reads stayed empty, which reads as "migrate claims success but does
nothing" rather than "migrate wrote somewhere else". A SQLite-backed Nightly
Canary failed this way for two weeks.

The resolved filename is now rejected when it names a database server, before
the `mkdir` runs:

```
createSqliteDatabase() received a connection URI where it expects a file path:
postgres://guren:guren@localhost:54322/guren (from DATABASE_URL). Left alone it
would be created as a directory tree and migrated into silently.
```

The check is on the resolved value rather than on the option, so it also covers
the `filename`-less path, where the driver falls back to `process.env.DATABASE_URL`
— an ambient Postgres URL that a SQLite app never meant to consume is the
likeliest way to hit this, and the option is not involved.

Rejected are `postgres://…`, `mysql://…`, `libsql://…` and anything else naming
a server. Filenames are not, and that includes two shapes a plain authority
check would have swept up: `file:` is sqlite's own URI scheme and never
addresses a server, so `file:///absolute/path.db` keeps working alongside
`file:local.db` and `file::memory:`; and a one-letter scheme is a Windows drive
rather than a scheme, so `C://data/app.db` keeps working alongside
`C:/data/app.db`. Plain `:memory:`, `./data/guren.db` and absolute paths were
never in scope.
