---
"@guren/orm": minor
---

`withCount()` issues one `SELECT fk, COUNT(*) ... GROUP BY fk` per relation
instead of loading every related row and counting in JS (`morphMany` loaded the
whole relation). A `belongsTo` count reads the owner key column alone, the
answer being 0 or 1. The related model's global scopes still apply, so a
soft-deleted child is not counted. An adapter without the grouped-count method
falls back to loading rows, narrowed to the key column where it can project and
whole where it cannot.

The IN list behind `withCount()` and every eager load (`hasMany`, `hasOne`,
`belongsTo`, `belongsToMany`, `hasManyThrough`, `morphMany`, `morphTo`) is split
into batches the adapter says the driver admits. `ORMAdapterAdvanced` gains an
optional `maxInListSize()`; `DrizzleAdapter` answers 5000 for the dialects that
number their parameters or backtick their names (Postgres, MySQL) and 500 for
anything it cannot place. For `belongsToMany` and `hasManyThrough` the keys
split that way are the related rows', not the parents'.

A `with()` constraint carrying `limit()`, `offset()` or `orderBy()` describes
the whole result set, so a load carrying one is answered by a single query
rather than one per batch. Its IN list is the only one a large enough parent set
can push past the driver's own limit.
