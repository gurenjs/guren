---
"create-guren-app": patch
---

Refuse a scheme in DATABASE_URL for scaffolded SQLite apps

`DATABASE_URL` names the SQLite database for two different implementations. The
app opens it with `bun:sqlite`, which honours URI filenames; drizzle-kit opens
it with `node:sqlite`, which does not. So `file:` is not a shared spelling of
anything:

| `DATABASE_URL` | app | drizzle-kit |
| --- | --- | --- |
| `./data/guren.db` | `data/guren.db` | same |
| `file:local.db` | `local.db` | a file *named* `file:local.db` |
| `file::memory:` | in-memory | a file *named* `file::memory:` |
| `file:///abs.db` | `/abs.db` | fails to open |

The first two rows are the dangerous ones: neither side errors, so migrations
land in one database while the app reads another — the same silent split a
connection string used to cause before `@guren/orm` started rejecting those.

The generated `drizzle.config.ts` now refuses any scheme rather than only one
carrying an authority, so the accepted set is what both implementations agree
on: plain paths and `:memory:`. The scheme must be two characters or more,
since no registered scheme is one letter while `C:/data/app.db` is a Windows
drive path.

Postgres and MySQL are untouched — `DATABASE_URL` really is a connection string
there, and their generated config is byte-identical to before.

Note this is deliberately stricter than the rule `@guren/orm` applies to
`createSqliteDatabase({ filename })`, which accepts `file:` URIs. There
`bun:sqlite` is the only consumer and the URI forms genuinely work; the
config's value has to satisfy both implementations, so its safe set is the
intersection.
