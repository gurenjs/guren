import type { Model, PlainObject } from './Model'
import type { QueryBuilder } from './QueryBuilder'

/**
 * Interface describing the static methods added by the SoftDeletes mixin.
 */
export interface SoftDeletesStatic {
  /** Column name used for tracking soft deletion timestamp. */
  deletedAtColumn: string
  /** Default scope that excludes soft-deleted records. */
  defaultScope: (q: QueryBuilder<any>) => QueryBuilder<any> // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Start a query that includes soft-deleted records. */
  withTrashed(): QueryBuilder<PlainObject>
  /** Start a query that returns only soft-deleted records. */
  onlyTrashed(): QueryBuilder<PlainObject>
  /** Restore soft-deleted records by setting deletedAt back to null. */
  restore(where: Partial<Record<string, unknown>>): Promise<PlainObject>
  /** Permanently delete records from the database, bypassing soft delete. */
  forceDelete(where: Partial<Record<string, unknown>>): Promise<number | PlainObject | void>
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

  // Register as both defaultScope (backward compat) and named global scope
  const scopeFn = (q: QueryBuilder<any>) => q.whereNull('deletedAt') // eslint-disable-line @typescript-eslint/no-explicit-any
  SoftDeleteModel.defaultScope = scopeFn
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
    const table = this.resolveTable()
    const column = (this as unknown as SoftDeletesStatic).deletedAtColumn
    return adapter.update(table, where, { [column]: new Date() }) as Promise<PlainObject>
  } as typeof Model.delete

  SoftDeleteModel.withTrashed = function (this: typeof Model): QueryBuilder<PlainObject> {
    return (this as unknown as { withoutGlobalScopes(): QueryBuilder<PlainObject> }).withoutGlobalScopes()
  }

  SoftDeleteModel.onlyTrashed = function (this: typeof Model): QueryBuilder<PlainObject> {
    const column = (this as unknown as SoftDeletesStatic).deletedAtColumn
    return (this as unknown as { withoutGlobalScopes(): QueryBuilder<PlainObject> }).withoutGlobalScopes()
      .whereNotNull(column)
  }

  SoftDeleteModel.restore = async function (
    this: typeof Model,
    where: Partial<Record<string, unknown>>,
  ): Promise<PlainObject> {
    const adapter = this.getAdapter()
    if (!adapter.update) {
      throw new Error('Configured adapter does not support update operations (needed for restore).')
    }
    const table = this.resolveTable()
    const column = (this as unknown as SoftDeletesStatic).deletedAtColumn
    return adapter.update(table, where, { [column]: null }) as Promise<PlainObject>
  }

  SoftDeleteModel.forceDelete = async function (
    this: typeof Model,
    where: Partial<Record<string, unknown>>,
  ): Promise<number | PlainObject | void> {
    const adapter = this.getAdapter()
    if (!adapter.delete) {
      throw new Error('Configured adapter does not support delete operations.')
    }
    const table = this.resolveTable()
    return adapter.delete(table, where)
  }

  return SoftDeleteModel
}
