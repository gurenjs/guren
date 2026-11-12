---
'@guren/orm': patch
---

`findWith()` and `findWithOrFail()` load relations before the model's casts and accessors run, as `with()` and the query builder do. A cast or an accessor that rewrote a key column (a morphTo type column, a foreign key) made the loader match on the rewritten value and return `null` or an empty list.
