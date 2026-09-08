---
"@guren/orm": patch
---

**`SoftDeletes` runs inside the transaction it was given** — the mixin's `delete()` override was declared `(where)` only and cast to `typeof Model.delete`, so the write options carrying `trx` were dropped where the type system could not see it. A soft delete made inside `Model.transaction()` therefore ran on the default connection: it survived a rollback, and the transaction's own reads could not see it. The override now takes `writeOptions` and threads them into the scoped builder, which is all `Model.transaction()`'s bound scope needed — `txPost.delete({ id })` is correct with no change to the transaction proxy.

`restore()`, `forceDelete()`, `withTrashed()` and `onlyTrashed()` could not be given a transaction at all, since they reach trashed rows through `withoutGlobalScope()`, which took only scope names. Each now accepts write or query options as a trailing argument, and `withoutGlobalScope()` gained an overload taking them *first* — `names` is a rest parameter and cannot be followed by an optional one. The name-only form is unchanged. `withoutGlobalScopes()` takes them trailing, like every other entry point.

`forceDelete()` is the sharp end of the group: a hard delete that escapes the surrounding rollback cannot be undone.
