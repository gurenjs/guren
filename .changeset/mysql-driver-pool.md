---
'@guren/orm': patch
---

Fix `createMySqlDatabase()`, which failed on every query

Any statement against a MySQL app — including the first one `db:migrate` runs —
threw `undefined is not an object (evaluating
'client.config.supportBigNumbers = !0')` before touching a socket, so MySQL was
unusable even though `create-guren-app --db mysql` offers it. Passing a
connection to `drizzle()` makes it build the pool through `mysql2/promise`,
whose wrapper exposes no `config` object for the driver to write that flag onto.
The ORM now creates the pool itself with `mysql2`'s callback API and hands
drizzle a client, matching how the PostgreSQL helper already works, and closes
that pool directly instead of reaching for drizzle's `$client`.

The existing tests could not catch this: they mock `drizzle-orm/mysql2` away, so
the real adapter was never exercised. A MySQL integration test now runs against
a live server (`MYSQL_URL`, backed by a `mysql` service in CI and
`bun run db:up:mysql` locally).
