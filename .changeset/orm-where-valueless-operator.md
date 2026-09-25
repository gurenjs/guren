---
'@guren/orm': patch
---

`where(field, 'is null')` and `where(field, 'is not null')` (two arguments, so the value form) now throw instead of compiling to `field = 'is null'`. The call type-checks (on any column from `Model.where()`, on string columns from a builder), and it silently dropped every NULL row. The error names `whereNull()` / `whereNotNull()` and the three-argument form `where(field, 'is null', null)`; `orWhere()` and the `where()` of a transaction scope behave the same. A value equal to a value-taking operator (`'like'`, `'in'`) is still read as a value.

The throw also reaches a two-argument call whose value comes from input: `Post.where('title', input)` with `input === 'is null'` used to match that title and now throws. Pass such input as `where('title', '=', input)`. It ships as a patch because the typed call it targets never returned what it read as; `find()` / `findOrFail()` on a scoped model are unaffected, since they now filter through the object form.

The transaction scope's `where()` now tells the operator form from the value form by argument count, as `Model.where()` does: a wrapper that always forwards three arguments, `where(f, v, undefined)`, has `v` read as the operator.
