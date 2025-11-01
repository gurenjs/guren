import { DrizzleAdapter } from './adapters/drizzle-adapter'

export type PlainObject = Record<string, unknown>
export type WhereClause = Record<string, unknown>

export interface ORMAdapter {
  findMany<TRecord = PlainObject>(table: unknown, where?: WhereClause): Promise<TRecord[]>
  findUnique<TRecord = PlainObject>(table: unknown, where: WhereClause): Promise<TRecord | null>
  create<TRecord = PlainObject>(table: unknown, data: PlainObject): Promise<TRecord>
  update?<TRecord = PlainObject>(table: unknown, where: WhereClause, data: PlainObject): Promise<TRecord>
  delete?<TRecord = PlainObject>(table: unknown, where: WhereClause): Promise<number | PlainObject | void>
}

/**
 * Minimal ActiveRecord-like wrapper around the configured ORM adapter. The API
 * mirrors a subset of Laravel's Eloquent helpers and can be expanded over time.
 */
export abstract class Model<TRecord extends object = PlainObject> {
  protected static ormAdapter: ORMAdapter = DrizzleAdapter
  protected static table: unknown
  static readonly recordType: unknown = undefined as unknown

  static useAdapter(adapter: ORMAdapter): void {
    this.ormAdapter = adapter
  }

  static getAdapter(): ORMAdapter {
    return this.ormAdapter
  }

  protected static resolveTable(): unknown {
    if (!this.table) {
      throw new Error(`${this.name}.table must be defined before using the model.`)
    }

    return this.table
  }

  static async all<T extends typeof Model>(this: T): Promise<Array<TRecordFor<T>>> {
    const table = this.resolveTable()
    return this.getAdapter().findMany(table) as Promise<Array<TRecordFor<T>>>
  }

  static async find<T extends typeof Model>(this: T, id: unknown, key = 'id'): Promise<TRecordFor<T> | null> {
    const table = this.resolveTable()
    const where: WhereClause = { [key]: id }
    return this.getAdapter().findUnique(table, where) as Promise<TRecordFor<T> | null>
  }

  static async where<T extends typeof Model>(this: T, where: WhereClause): Promise<TRecordFor<T>[]> {
    const table = this.resolveTable()
    return this.getAdapter().findMany(table, where) as Promise<TRecordFor<T>[]>
  }

  static async create<T extends typeof Model>(this: T, data: PlainObject): Promise<TRecordFor<T>> {
    const table = this.resolveTable()
    return this.getAdapter().create(table, data) as Promise<TRecordFor<T>>
  }

  static async update<T extends typeof Model>(this: T, where: WhereClause, data: PlainObject): Promise<TRecordFor<T>> {
    const table = this.resolveTable()
    const adapter = this.getAdapter()
    if (!adapter.update) {
      throw new Error('Configured adapter does not support update operations.')
    }

    return adapter.update(table, where, data) as Promise<TRecordFor<T>>
  }

  static async delete<T extends typeof Model>(this: T, where: WhereClause): Promise<number | PlainObject | void> {
    const table = this.resolveTable()
    const adapter = this.getAdapter()
    if (!adapter.delete) {
      throw new Error('Configured adapter does not support delete operations.')
    }

    return adapter.delete(table, where)
  }
}

type TRecordFor<T extends typeof Model> = T extends { recordType: infer R }
  ? R extends object
    ? R
    : PlainObject
  : PlainObject
