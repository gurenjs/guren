---
'@guren/orm': patch
---

Apply global scopes on every query entry point, not just four of them

`defaultScope` and the `addGlobalScope()` registry were applied by `newQuery()`,
and by `all()` / `find()` / `first()` which branch into it. Every other entry
point skipped them: `where()` and its `whereNull` / `whereNotNull` / `whereIn` /
`whereNotIn` / `select` / `scope` siblings constructed a bare `QueryBuilder`, and
`orderBy()` / `paginate()` called the adapter directly. The relation loaders go
through `where()`, so eager loading dropped the *related* model's scopes too.

The docs present global scopes as a filter that always applies, name
multi-tenancy as the first use case, and state that `where()` is covered — so an
app following the documented pattern got no tenant isolation on the most common
entry point. `SoftDeletes` is implemented as a global scope and inherited every
hole, which is how a scaffolded `index()` — `make:feature` generates it as
`Model.paginate(...)` on a route with no auth — served soft-deleted rows.
`paginate()` leaked the unscoped row count through `meta.total` as well.

All of these now route through the scope-applying builder. `newQuery()` with no
scopes registered constructs exactly what the bare builder did, so an app that
uses no global scopes is unaffected. `withoutGlobalScope(s)` remains the way out.

