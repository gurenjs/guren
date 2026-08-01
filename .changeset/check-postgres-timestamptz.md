---
"@guren/cli": minor
---

Flag Postgres timestamp columns declared without a time zone in `guren check`

Every Guren scaffold now emits `timestamp(name, { withTimezone: true })` for
Postgres, but nothing caught an offset-less column in a schema written by hand
or by an AI agent reproducing an older pattern. `guren check` now warns on one.

`timestamp without time zone` stores a bare wall clock, and who reads it decides
what that clock meant: `defaultNow()` records the wall clock of the *database
session's* zone while the app reads the column back as UTC — so on a non-UTC
session the stored instant is simply wrong — and any non-Drizzle reader (psql, a
report, another service) sees a different instant than the app does for values
the app wrote itself.

```
[warn] posts.createdAt time zone: Postgres column 'created_at' is 'timestamp
       without time zone', which stores a bare wall clock: ...
     → In db/schema.ts, declare it as timestamp('created_at', { withTimezone: true })
       and generate a migration. ...
```

Postgres only, decided per table by the factory that declared it (`pgTable`),
not per file — so a schema mixing dialects is judged a table at a time. MySQL
has no `timestamptz` and its `TIMESTAMP` is already UTC-normalized, so its bare
`timestamp('created_at')` is correct and stays silent even though it is spelled
identically; sqlite stores epoch integers via `integer(..., { mode })`.

The result is a `warn` in the core suite, which means it is **informational**:
plain `guren check` has never set an exit code, and only `--arch` / `--docs` /
`--spec` gate CI. This will not fail a build — fixing an existing column
requires a migration whose `USING` clause needs a human decision about which
zone the stored rows were written in.

Silence is not proof. The schema is read statically and nothing resolves an
identifier back to what it names, so several legal spellings are skipped rather
than misjudged: columns introduced by a spread (`...timestamps`, the
shared-column idiom), builders reached through an alias (`timestamp as ts`) or a
namespace (`p.timestamp(...)`), options passed as an expression
(`timestamp('created_at', SHARED_OPTIONS)`), and tables declared in a file the
schema merely re-exports. Reporting a column that is actually fine would cost
more than missing one — the fix this suggests is a migration.

`parseSchemaTables` grew the facts the rule needed: `SchemaTable.dialect`, plus
`SchemaColumn.withTimezone` (as written — `true`, `false`, or absent),
`SchemaColumn.columnName` (the database name, so the suggestion quotes the
column rather than the object key it is declared under), and
`SchemaColumn.opaqueOptions` (set when the options were not an inline object, so
an absent one reads as "not visible" rather than "not set").
