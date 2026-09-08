---
"@guren/orm": patch
---

**`Model.transaction()` is atomic on SQLite** — `DrizzleAdapter.transaction()` delegated to `db.transaction(callback)`, which is *synchronous* on drizzle's bun-sqlite driver: it runs `BEGIN`, calls the callback and `COMMIT`s on whatever it returns. `Model.transaction()` takes an async callback by contract, so the pending promise was committed immediately and every awaited write inside the callback ran after the `COMMIT` — a throw rolled back nothing. Measured against drizzle-orm 1.0.0-rc.4: a `Model.transaction()` that inserted a row and then threw left the row in the database. SQLite is the default database for scaffolded apps, so this affected them out of the box.

The adapter now probes once per configured database whether `db.transaction()` awaits its callback, and drives `BEGIN` / `COMMIT` / `ROLLBACK` itself when it does not. Every async driver (postgres-js, mysql2, D1, AWS Data API) keeps drizzle's own transaction, which already awaits. A database that neither awaits its callback nor exposes `run()` cannot be made atomic and now throws instead of silently providing no guarantee.

These drivers hold a single connection, so two transactions cannot overlap on one: a `Model.transaction()` that begins while another is open — a nested call, or one whose callback awaits non-database work — is now refused with an error naming that constraint, leaving the open transaction intact. It previously appeared to succeed while being atomic in neither case.
