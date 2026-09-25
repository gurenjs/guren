---
'@guren/orm': patch
---

`where(field, 'is null')` and `where(field, 'is not null')` (two arguments, so the value form) now throw instead of compiling to `field = 'is null'`. The two-argument overload admits any string on a text column, so the query type-checked and silently dropped every NULL row. The error names `whereNull()` / `whereNotNull()` and the three-argument form `where(field, 'is null', null)`; `orWhere()` and the `where()` of a transaction scope behave the same. A patch rather than a minor because the only calls that start throwing are ones that already returned the wrong rows; to match the literal string, write `where(field, '=', 'is null')`. A value equal to a value-taking operator (`'like'`, `'in'`) is still read as a value.

The transaction scope's `where()` now tells the operator form from the value form by argument count, as `Model.where()` does, so `where(field, 'is null', undefined)` is the operator form there too.
