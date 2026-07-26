---
'create-guren-app': patch
'@guren/orm': patch
---

Name the real cause when migrations fail, and give container-backed apps `db:up`/`db:down`

`db:migrate` against a database that is not reachable used to report `Failed to
run database migrations: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"` —
the migrator's own bookkeeping statement, not anything the user wrote. The
driver's `ECONNREFUSED` lived on the error's `cause`, which was discarded. It now
reports `cannot connect to the database at localhost:54322 (ECONNREFUSED). Is it
running and accepting connections?`, with the host and port only so the
connection string's credentials stay out of the log. Genuine SQL failures now
carry the driver's message alongside the query instead of the query alone.

Scaffolding with PostgreSQL or MySQL also writes `db:up` and `db:down` scripts
next to the generated `docker-compose.yml`, so starting the database is
discoverable from `package.json`. The selected driver is no longer listed in both
`dependencies` and `devDependencies`, which made `bun install` warn about a
duplicate dependency on the first command a new project runs.
