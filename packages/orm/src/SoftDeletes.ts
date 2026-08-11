import type { Model, PlainObject } from './Model'
import { PREPARED_UPDATE, type QueryBuilder } from './QueryBuilder'

/**
 * Interface describing the static methods added by the SoftDeletes mixin.
 */
export interface SoftDeletesStatic {
  /** Column name used for tracking soft deletion timestamp. */
  deletedAtColumn: string
  /** Start a query that includes soft-deleted records. */
  withTrashed(): QueryBuilder<PlainObject>
  /** Start a query that returns only soft-deleted records. */
  onlyTrashed(): QueryBuilder<PlainObject>
  /** Restore soft-deleted records by setting deletedAt back to null. */
  restore(where: Partial<Record<string, unknown>>): Promise<PlainObject>
  /** Permanently delete records from the database, bypassing soft delete. */
  forceDelete(where: Partial<Record<string, unknown>>): Promise<number | PlainObject | void>
}

/** A query carrying every global scope this model has, including softDelete. */
function scopedQuery(model: typeof Model, where: Partial<Record<string, unknown>>): QueryBuilder<PlainObject> {
  return (model.newQuery() as QueryBuilder<PlainObject>).where(where)
}

/** A query carrying every global scope *except* softDelete, so it sees trashed rows. */
function withoutSoftDeleteScope(model: typeof Model): QueryBuilder<PlainObject> {
  return model.withoutGlobalScope('softDelete') as QueryBuilder<PlainObject>
}

function trashedScopedQuery(model: typeof Model, where: Partial<Record<string, unknown>>): QueryBuilder<PlainObject> {
  return withoutSoftDeleteScope(model).where(where)
}

/**
 * Mixin that adds soft delete behavior to a Model.
 *
 * When applied, `delete()` sets a `deletedAt` timestamp instead of removing the
 * record from the database. All default queries automatically exclude soft-deleted
 * records via a global scope named 'softDelete'.
 *
 * @example
 * class Post extends SoftDeletes(defineModel(posts)) {}
 *
 * // Soft delete a record (sets deletedAt)
 * await Post.delete({ id: 1 })
 *
 * // Query only non-deleted records (default behavior)
 * const posts = await Post.all()
 *
 * // Include soft-deleted records
 * const allPosts = await Post.withTrashed().get()
 *
 * // Query only soft-deleted records
 * const trashed = await Post.onlyTrashed().get()
 *
 * // Restore a soft-deleted record
 * await Post.restore({ id: 1 })
 *
 * // Permanently delete a record
 * await Post.forceDelete({ id: 1 })
 */
export function SoftDeletes<TBase extends typeof Model>(Base: TBase): TBase & SoftDeletesStatic {
  const SoftDeleteModel = class extends (Base as typeof Model) {} as unknown as TBase & SoftDeletesStatic

  SoftDeleteModel.deletedAtColumn = 'deletedAt'

  // Registered only as a *named* global scope, never as `defaultScope`.
  // `withoutGlobalScope('softDelete')` keeps applying `defaultScope`, so a
  // double registration would make the filter unremovable — and `restore()` /
  // `forceDelete()` have to reach trashed rows while every *other* global scope
  // (a tenant filter, say) stays on.
  const scopeFn = (q: QueryBuilder<any>) => q.whereNull('deletedAt') // eslint-disable-line @typescript-eslint/no-explicit-any
  ;(SoftDeleteModel as unknown as typeof Model).addGlobalScope('softDelete', scopeFn)

  // Override delete to do a soft delete (set deletedAt)
  ;(SoftDeleteModel as unknown as typeof Model).delete = async function (
    this: typeof Model,
    where: Partial<Record<string, unknown>>,
  ): Promise<number | PlainObject | void> {
    const adapter = this.getAdapter()
    if (!adapter.update) {
      throw new Error('Configured adapter does not support update operations (needed for soft delete).')
    }
    const column = (this as unknown as SoftDeletesStatic).deletedAtColumn
    // Through the scoped builder, not straight to the adapter: the caller's
    // `where` alone ignores every global scope, so one tenant could soft-delete
    // another tenant's row. `newQuery()` also carries the softDelete filter, so
    // only a live row is marked. The payload is written as-is, as before —
    // the prepared-payload terminal skips mutators and casts.
    return scopedQuery(this, where)[PREPARED_UPDATE]({ [column]: new Date() })
  } as typeof Model.delete

  SoftDeleteModel.withTrashed = function (this: typeof Model): QueryBuilder<PlainObject> {
    return withoutSoftDeleteScope(this)
  }

  SoftDeleteModel.onlyTrashed = function (this: typeof Model): QueryBuilder<PlainObject> {
    const column = (this as unknown as SoftDeletesStatic).deletedAtColumn
    return withoutSoftDeleteScope(this).whereNotNull(column)
  }

  SoftDeleteModel.restore = async function (
    this: typeof Model,
    where: Partial<Record<string, unknown>>,
  ): Promise<PlainObject> {
    const adapter = this.getAdapter()
    if (!adapter.update) {
      throw new Error('Configured adapter does not support update operations (needed for restore).')
    }
    const column = (this as unknown as SoftDeletesStatic).deletedAtColumn
    // Drops only the softDelete filter, so this reaches a trashed row while a
    // tenant scope still stops it from un-deleting somebody else's.
    return trashedScopedQuery(this, where)[PREPARED_UPDATE]({ [column]: null })
  }

  SoftDeleteModel.forceDelete = async function (
    this: typeof Model,
    where: Partial<Record<string, unknown>>,
  ): Promise<number | PlainObject | void> {
    const adapter = this.getAdapter()
    if (!adapter.delete) {
      throw new Error('Configured adapter does not support delete operations.')
    }
    // The sharpest of the three: an unscoped hard delete is unrecoverable, so
    // the tenant scope has to survive. Only the softDelete filter is dropped,
    // which is what lets a force delete reach trashed rows as well as live ones.
    return trashedScopedQuery(this, where).delete()
  }

  return SoftDeleteModel
}
