---
'@guren/orm': patch
---

Apply global scopes to `Model.update()`, `forceUpdate()`, and `delete()`

Read entry points (`all`, `find`, `first`, `where`, `paginate`, …) route through
the scope-applying builder, but the static write shortcuts did not: `update()`,
`forceUpdate()`, and `delete()` forwarded the caller's `where` straight to the
adapter, dropping every global scope. The docs recommend global scopes for
multi-tenancy ("any filter that should always be active"), so a tenant scope that
isolated reads still let one tenant update or delete another tenant's row — the
row was hidden from `find()` yet writable by id.

These three now add the model's scopes to the write, the same way reads do. The
already-prepared payload is threaded through a symbol-keyed builder terminal so
mutators and casts still run exactly once (routing it through the fluent
`update()` would have re-run them, e.g. double-hashing a hashed column). The
symbol is not re-exported from the package entry point: a named public method
there would have been a supported way to write arbitrary columns, since it
skips both mass-assignment filtering and payload preparation.
`withoutGlobalScope()` / `withoutGlobalScopes()` remain the explicit opt-out.

The fluent form (`Post.where({ id }).update(data)`) was already scoped and is
unchanged. Soft-delete's own `delete`/`restore`/`forceDelete` carry the same
class of gap and are addressed separately, since restoring a trashed row needs to
drop only the soft-delete filter while keeping the tenant scope.
