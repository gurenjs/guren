---
"@guren/orm": patch
---

`Model.transaction()` now tracks the open transaction in async context. A nested call joins it instead of opening a second top-level transaction, which on the `max: 1` pools the Postgres and MySQL factories create waited on the connection the outer one held (a deadlock), and which the single-connection SQLite driver refused with an error. A model call inside the callback with no `{ trx }` runs on the open transaction too, so a write that forgot the handle is rolled back with the rest rather than committing on the pool. An explicit `{ trx }` keeps working as before. Joining means no savepoint: an inner error the outer callback catches leaves the inner writes in place until the outer transaction settles.
