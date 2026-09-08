---
"@guren/orm": patch
---

**`Model.transaction()` is atomic on SQLite** — `DrizzleAdapter.transaction()` delegated to `db.transaction(callback)`, which is *synchronous* on drizzle's bun-sqlite driver: it runs `BEGIN`, calls the callback and `COMMIT`s on whatever it returns. `Model.transaction()` takes an async callback by contract, so the pending promise was committed immediately and every awaited write inside the callback ran after the `COMMIT` — a throw rolled back nothing. Measured against drizzle-orm 1.0.0-rc.4: a `Model.transaction()` that inserted a row and then threw left the row in the database. SQLite is the default database for scaffolded apps, so this affected them out of the box.

The adapter now probes once per configured database whether `db.transaction()` awaits its callback, and drives `BEGIN` / `COMMIT` / `ROLLBACK` itself when it does not. Every async driver (postgres-js, mysql2, D1, AWS Data API) keeps drizzle's own transaction, which already awaits. A database that neither awaits its callback nor exposes `run()` cannot be made atomic and now throws instead of silently providing no guarantee.

These drivers hold a single connection, which takes one transaction at a time, so the transactions this adapter drives are serialized: transactions started concurrently — `Promise.all([Model.transaction(…), Model.transaction(…)])` — now run one after another and each commits or rolls back on its own. A transaction that begins while another is already *open* cannot be queued behind it, because a nested call would be waiting on itself; that case is refused with an error naming the constraint, leaving the open transaction intact. It reaches nesting, and a transaction started while another callback awaits non-database work.
