---
'@guren/orm': minor
'@guren/core': minor
---

`Model.create()` and `Model.update()` take a `set` option for columns the server chooses, such as an owner: `Post.create(data, { set: { authorId: user.id } })` (RFC 0031). `data` is filtered by `fillable` as before. The `set` columns skip it, and must not be listed in it. That rule also refuses request data spread into `set`. The same rules refuse a `set` on a model without `fillable`, an `id` or a denied column in `set`, and a key in both `data` and `set`. Every refusal is a `MassAssignmentException` with the existing `denied` or `not-fillable` reason. The transaction scope's `create` and `update` take the option too, and `ModelSetOptions` is exported from `@guren/orm` and `@guren/core`.

Calls without `set` keep their signatures and behaviour. The `not-fillable` message now points at `set` for a value the server chooses, instead of at `forceCreate()`.
