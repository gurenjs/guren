import type { Model, PlainObject } from './Model'
import { PREPARED_UPDATE, type QueryBuilder } from './QueryBuilder'

/** The static methods the SoftDeletes mixin adds. */
export interface SoftDeletesStatic {
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
 * Mixin where `delete()` sets `deletedAt` instead of removing the row, and a
 * global scope named 'softDelete' excludes those rows from every query.
 *
 * @example
 * class Post extends SoftDeletes(defineModel(posts)) {}
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
    // `where` alone ignores every global scope, so one tenant could
    // soft-delete another tenant's row. PREPARED_UPDATE skips mutators/casts.
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
    // An unscoped hard delete is unrecoverable, so every scope but softDelete
    // has to survive; dropping that one is what reaches trashed rows too.
    return trashedScopedQuery(this, where).delete()
  }

  return SoftDeleteModel
}
