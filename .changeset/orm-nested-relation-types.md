---
'@guren/orm': minor
'@guren/core': minor
'@guren/cli': patch
---

Accept dot-notation nested relation paths (`with('comments.author')`) in the type signatures of `with()`, `findWith()`, `findWithOrFail()`, and `withPaginate()` — the runtime already supported them. Add `BelongsToRequiredRecord<T>` for belongsTo relations backed by a NOT NULL foreign key, so `relationTypes` can declare the parent as non-nullable (use the `declare` modifier to skip the runtime placeholder).
