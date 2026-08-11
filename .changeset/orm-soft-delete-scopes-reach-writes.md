---
'@guren/orm': patch
---

Apply global scopes to `SoftDeletes`' `delete()`, `restore()`, and `forceDelete()`

The companion to the fix for the static write shortcuts: the `SoftDeletes` mixin
overrides all three, and each forwarded the caller's `where` straight to the
adapter, dropping every global scope. On a multi-tenant app with a `tenant`
scope, `delete()` soft-deleted, `restore()` un-deleted, and `forceDelete()`
*permanently* removed another tenant's row — the sharpest of the three, since a
hard delete cannot be undone. `withTrashed()` and `onlyTrashed()` had the mirror
of the same bug: they dropped every scope to escape the soft-delete filter, so
they returned other tenants' trashed rows.

The three writes now run through the scope-applying builder. `delete()` uses the
full scope set, so it marks only a live row the current scopes can see;
`restore()` and `forceDelete()` drop the `softDelete` scope alone, reaching
trashed rows while a tenant scope keeps them in bounds. `withTrashed()` /
`onlyTrashed()` do the same, which makes the documented equivalence between
`withTrashed()` and `withoutGlobalScope('softDelete')` literally true for the
first time.

Two supporting changes made that possible:

- The mixin no longer registers its filter as `defaultScope` in addition to the
  named `'softDelete'` scope. `withoutGlobalScope()` re-applies `defaultScope`,
  so the double registration made the filter unremovable by name. `defaultScope`
  is therefore gone from the `SoftDeletesStatic` type (re-exported from
  `@guren/core`); reading `Post.defaultScope` still compiles through `Model`'s
  own optional declaration, but calling it unguarded no longer does.
- A subclass that registers its own scope now seeds its registry from the
  inherited one instead of starting empty. Without this,
  `class Post extends SoftDeletes(Base)` followed by
  `Post.addGlobalScope('tenant')` silently dropped the inherited `softDelete`
  filter — masked until now by the `defaultScope` registration above. The copy
  is a snapshot: scopes added to a parent after a subclass first registers or
  removes one do not propagate.

Two visible behavior changes: `Post.delete({ id })` on an already-trashed row is
now a no-op rather than refreshing `deletedAt`, since the soft-delete scope
excludes it; and `withTrashed()` / `onlyTrashed()` no longer return rows that
other global scopes exclude. The mixin's `delete` override still bypasses the
`deleting` / `deleted` hooks, exactly as before.
