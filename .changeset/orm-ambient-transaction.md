---
"@guren/orm": patch
---

`Model.transaction()` now tracks the open transaction in async context. A
nested call runs as a savepoint on it instead of opening a second top-level
transaction, which on the `max: 1` pool the Postgres factory creates waited on
the connection the outer one held (a deadlock), and which the
single-connection SQLite driver refused with an error. An inner error the outer
callback catches therefore discards only the inner writes. Nested transactions
have to be awaited one at a time: savepoints on one connection are released in
the order they were taken, so two running at once discard each other's frames.

A model call inside the callback with no `{ trx }` runs on the open transaction
too, so a write that forgot the handle is rolled back with the rest rather than
committing on the pool. An explicit `{ trx }` keeps working as before. A
promise nobody awaited outlives the transaction it was started in, and a query
it issues after that runs on the pool rather than on a handle the driver has
already finalised.
