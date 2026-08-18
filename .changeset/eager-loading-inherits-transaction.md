---
'@guren/orm': minor
---

Eager-loaded relations now run on the transaction that read their parents.

`QueryBuilder` carried its `trx` into the parent query but not into the relation
queries `with()` issues, so a transaction-bound `get()`, `first()` or
`paginate()` read parents inside the transaction and their relations on the
pool. On Postgres and MySQL, where the transaction selects a connection, that
means relations of uncommitted parents came back `null` (or empty), and reads
could be inconsistent even when they did not.

`Model.loadRelationInto()` and every relation loader it delegates to
(`belongsTo`, `hasMany`, `hasOne`, `belongsToMany`, `hasManyThrough`,
`morphMany`, `morphTo`, and nested-path recursion) now accept
`ModelQueryOptions` and pass it to each related query, including the pivot and
through-table reads. `QueryBuilder` forwards its own `trx`.

`Model.with()`, `findWith()`, `findWithOrFail()`, `withPaginate()` and
`withCount()` gained an optional trailing `queryOptions` argument so they can
forward a transaction too. These five previously took no query options at all,
so this completes the plumbing rather than fixing a reachable bug in them.
