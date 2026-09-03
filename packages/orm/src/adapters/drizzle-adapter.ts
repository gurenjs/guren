import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { AnyColumn } from 'drizzle-orm'
import type { AdapterQueryOptions, FindManyOptions, OrderByClause, PlainObject, WhereClause } from '../Model'
import type { ORMAdapterAdvanced, WhereCondition } from '../QueryBuilder'
import { buildDrizzleConditions } from './drizzle-conditions'

type DrizzleLikeSelect = {
  where?: (clause: unknown) => DrizzleLikeSelect
  orderBy?: (...clauses: unknown[]) => DrizzleLikeSelect
  limit?: (value: number) => DrizzleLikeSelect
  offset?: (value: number) => DrizzleLikeSelect
  all?: () => Promise<unknown[]>
  get?: () => Promise<unknown>
}

type DrizzleSelectBuilder = DrizzleLikeSelect & { from(table: unknown): DrizzleLikeSelect }

type DrizzleLikeInsert = {
  values: (record: PlainObject) => DrizzleLikeInsertResult
}

type DrizzleLikeInsertResult = {
  returning?: () => Promise<unknown[]>
  run?: () => Promise<unknown>
}

type DrizzleLikeUpdate = {
  set: (record: PlainObject) => DrizzleLikeUpdate
  where: (clause: unknown) => DrizzleLikeUpdate
  returning?: () => Promise<unknown[]>
}

type DrizzleLikeDelete = {
  where: (clause: unknown) => DrizzleLikeDelete
  returning?: () => Promise<unknown[]>
  run?: () => Promise<unknown>
}

type DrizzleDatabase = {
  select(selection?: Record<string, unknown>): DrizzleSelectBuilder
  insert(table: unknown): DrizzleLikeInsert
  update?(table: unknown): DrizzleLikeUpdate
  delete?(table: unknown): DrizzleLikeDelete
  transaction?<TResult>(callback: (trx: unknown) => Promise<TResult>): Promise<TResult>
}

let database: DrizzleDatabase | undefined

function ensureDatabase(): DrizzleDatabase {
  if (!database) {
    throw new Error('DrizzleAdapter: database has not been configured. Call DrizzleAdapter.configure(db).')
  }

  return database
}

function resolveExecutor(options?: AdapterQueryOptions): DrizzleDatabase {
  if (options?.trx && typeof options.trx === 'object') {
    return options.trx as DrizzleDatabase
  }

  return ensureDatabase()
}

async function resolveList(result: DrizzleLikeSelect): Promise<unknown[]> {
  if (isPromiseLike(result)) {
    return result as unknown as Promise<unknown[]>
  }

  if (typeof result.all === 'function') {
    return result.all()
  }

  if (typeof result.get === 'function') {
    const item = await result.get()
    return item ? [item] : []
  }

  return []
}

type DrizzleTableLike = Record<string, unknown>

function resolveWhere(table: unknown, where?: WhereClause): unknown {
  if (!where || typeof where !== 'object') {
    return where
  }

  const tableRecord = table as DrizzleTableLike
  const clauses = Object.entries(where)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const column = tableRecord[key] as AnyColumn | undefined

      if (!column) {
        throw new Error(`DrizzleAdapter: unknown column "${key}" on provided table.`)
      }

      if (Array.isArray(value)) {
        return inArray(column, value)
      }

      if (value === null) {
        return isNull(column)
      }

      return eq(column, value)
    })
    .filter(Boolean)

  if (clauses.length === 0) {
    return undefined
  }

  if (clauses.length === 1) {
    return clauses[0]
  }

  return and(...clauses)
}

function resolveOrder(table: unknown, orderBy?: OrderByClause): unknown[] | undefined {
  if (!orderBy || orderBy.length === 0) {
    return undefined
  }

  const tableRecord = table as DrizzleTableLike
  return orderBy.map(({ column, direction }) => {
    const columnRef = tableRecord[column] as AnyColumn | undefined

    if (!columnRef) {
      throw new Error(`DrizzleAdapter: unknown column "${column}" on provided table.`)
    }

    return direction === 'desc' ? desc(columnRef) : asc(columnRef)
  })
}

async function resolveSingle(result: DrizzleLikeSelect): Promise<unknown | null> {
  if (isPromiseLike(result)) {
    const list = (await (result as unknown as Promise<unknown[]>)) ?? []
    return Array.isArray(list) ? list[0] ?? null : (list ?? null)
  }

  if (typeof result.get === 'function') {
    const item = await result.get()
    return item ?? null
  }

  if (typeof result.all === 'function') {
    const list = await result.all()
    return list[0] ?? null
  }

  return null
}

async function resolveMutation(result: DrizzleLikeInsertResult | DrizzleLikeUpdate | DrizzleLikeDelete): Promise<unknown> {
  if (isPromiseLike(result)) {
    return result as unknown as Promise<unknown>
  }

  if ('returning' in result && typeof result.returning === 'function') {
    const rows = await result.returning()
    return Array.isArray(rows) ? rows[0] ?? rows : rows
  }

  if ('run' in result && typeof result.run === 'function') {
    return result.run()
  }

  return result
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof (value as { then: unknown }).then === 'function'
}

/**
 * Eagerly call `.returning()` on a query builder if available.
 * This ensures SQLite (bun-sqlite) drivers return inserted/updated rows
 * instead of RunResult, since their query builders are thenable —
 * `resolveMutation`'s `isPromiseLike` check would otherwise win
 * before the `.returning()` check is reached.
 */
async function resolveWithReturning<T>(query: unknown): Promise<{ usedReturning: boolean; row: T | undefined }> {
  if (query && typeof query === 'object' && 'returning' in query && typeof (query as Record<string, unknown>).returning === 'function') {
    const rows = await (query as { returning: () => Promise<unknown> }).returning()
    return {
      usedReturning: true,
      row: (Array.isArray(rows) ? rows[0] : rows) as T | undefined,
    }
  }
  return { usedReturning: false, row: undefined }
}

export const DrizzleAdapter: ORMAdapterAdvanced & {
  configure(db: DrizzleDatabase): void
  getDatabase<TDatabase extends DrizzleDatabase = DrizzleDatabase>(): TDatabase
} = {
  configure(db: DrizzleDatabase) {
    database = db
  },

  getDatabase<TDatabase extends DrizzleDatabase = DrizzleDatabase>(): TDatabase {
    return ensureDatabase() as unknown as TDatabase
  },

  async findMany<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    options?: FindManyOptions<TRecord>,
    queryOptions?: AdapterQueryOptions,
  ): Promise<TRecord[]> {
    const db = resolveExecutor(queryOptions)
    let query = db.select().from(table)
    const { where, orderBy, limit, offset } = options ?? {}

    if (typeof query.where === 'function') {
      const clause = resolveWhere(table, where)
      if (clause) {
        query = query.where(clause) as DrizzleLikeSelect
      }
    }

    if (typeof query.orderBy === 'function') {
      const clauses = resolveOrder(table, orderBy as OrderByClause)
      if (clauses && clauses.length > 0) {
        query = query.orderBy(...clauses) as DrizzleLikeSelect
      }
    }

    if (typeof query.limit === 'function' && typeof limit === 'number') {
      query = query.limit(limit) as DrizzleLikeSelect
    }

    if (typeof query.offset === 'function' && typeof offset === 'number') {
      query = query.offset(offset) as DrizzleLikeSelect
    }

    const rows = await resolveList(query)
    return rows as TRecord[]
  },

  async count<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where?: WhereClause<TRecord>,
    queryOptions?: AdapterQueryOptions,
  ): Promise<number> {
    const db = resolveExecutor(queryOptions)
    let query = db.select({ value: count() }).from(table)

    if (typeof query.where === 'function') {
      const clause = resolveWhere(table, where)
      if (clause) {
        query = query.where(clause) as DrizzleLikeSelect
      }
    }

    const rows = await resolveList(query)
    const first = rows[0] as { value?: unknown } | undefined
    const raw = first?.value ?? 0
    const total = typeof raw === 'bigint' ? Number(raw) : Number(raw)
    return Number.isNaN(total) ? 0 : total
  },

  async findUnique<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
    queryOptions?: AdapterQueryOptions,
  ): Promise<TRecord | null> {
    const db = resolveExecutor(queryOptions)
    let query = db.select().from(table)

    if (typeof query.where === 'function') {
      const clause = resolveWhere(table, where)
      if (clause) {
        query = query.where(clause) as DrizzleLikeSelect
      }
    }

    const row = await resolveSingle(query)
    if (row == null) {
      return null
    }

    return row as TRecord
  },

  async create<TRecord = PlainObject>(
    table: unknown,
    data: PlainObject,
    writeOptions?: AdapterQueryOptions,
  ): Promise<TRecord> {
    const db = resolveExecutor(writeOptions)
    const query = db.insert(table).values(data)
    const { usedReturning, row } = await resolveWithReturning<TRecord>(query)
    if (usedReturning) return row as TRecord
    const result = await resolveMutation(query)
    return result as TRecord
  },

  async update<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
    data: PlainObject,
    writeOptions?: AdapterQueryOptions,
  ): Promise<TRecord> {
    const db = resolveExecutor(writeOptions)
    if (!db.update) {
      throw new Error('DrizzleAdapter: configured database does not support updates.')
    }

    const clause = resolveWhere(table, where)
    const finalQuery = clause ? db.update(table).set(data).where(clause) : db.update(table).set(data)
    const { usedReturning, row } = await resolveWithReturning<TRecord>(finalQuery)
    if (usedReturning) return row as TRecord
    const result = await resolveMutation(finalQuery)
    return result as TRecord
  },

  async delete<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
    writeOptions?: AdapterQueryOptions,
  ): Promise<number | PlainObject | void> {
    const db = resolveExecutor(writeOptions)
    if (!db.delete) {
      throw new Error('DrizzleAdapter: configured database does not support deletes.')
    }

    const clause = resolveWhere(table, where)
    const finalQuery = clause ? db.delete(table).where(clause) : db.delete(table)
    const { usedReturning, row } = await resolveWithReturning<PlainObject>(finalQuery)
    if (usedReturning) return row
    const result = await resolveMutation(finalQuery)
    return result as number | PlainObject | void
  },

  async findManyAdvanced<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
    options: {
      orderBy?: OrderByClause
      limit?: number
      offset?: number
      select?: string[]
    },
    queryOptions?: AdapterQueryOptions,
  ): Promise<TRecord[]> {
    const db = resolveExecutor(queryOptions)
    const tableRecord = table as DrizzleTableLike

    // Build select - if specific fields requested, build a selection object
    let query: DrizzleLikeSelect
    if (options.select && options.select.length > 0) {
      const selection: Record<string, unknown> = {}
      for (const field of options.select) {
        const column = tableRecord[field]
        if (!column) {
          throw new Error(`DrizzleAdapter: unknown column "${field}" on provided table.`)
        }
        selection[field] = column
      }
      query = db.select(selection).from(table)
    } else {
      query = db.select().from(table)
    }

    // Apply advanced conditions
    if (typeof query.where === 'function') {
      const clause = buildDrizzleConditions(table, conditions)
      if (clause) {
        query = query.where(clause) as DrizzleLikeSelect
      }
    }

    // Apply ordering
    if (typeof query.orderBy === 'function') {
      const clauses = resolveOrder(table, options.orderBy)
      if (clauses && clauses.length > 0) {
        query = query.orderBy(...clauses) as DrizzleLikeSelect
      }
    }

    // Apply limit
    if (typeof query.limit === 'function' && typeof options.limit === 'number') {
      query = query.limit(options.limit) as DrizzleLikeSelect
    }

    // Apply offset
    if (typeof query.offset === 'function' && typeof options.offset === 'number') {
      query = query.offset(options.offset) as DrizzleLikeSelect
    }

    const rows = await resolveList(query)
    return rows as TRecord[]
  },

  // oxlint-disable-next-line no-unused-vars -- phantom type parameter, kept because it is part of the public signature
  async countAdvanced<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
    queryOptions?: AdapterQueryOptions,
  ): Promise<number> {
    const db = resolveExecutor(queryOptions)
    let query = db.select({ value: count() }).from(table)

    if (typeof query.where === 'function') {
      const clause = buildDrizzleConditions(table, conditions)
      if (clause) {
        query = query.where(clause) as DrizzleLikeSelect
      }
    }

    const rows = await resolveList(query)
    const first = rows[0] as { value?: unknown } | undefined
    const raw = first?.value ?? 0
    const total = typeof raw === 'bigint' ? Number(raw) : Number(raw)
    return Number.isNaN(total) ? 0 : total
  },

  async updateAdvanced<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
    data: PlainObject,
    writeOptions?: AdapterQueryOptions,
  ): Promise<TRecord> {
    const db = resolveExecutor(writeOptions)
    if (!db.update) {
      throw new Error('DrizzleAdapter: configured database does not support updates.')
    }

    const clause = buildDrizzleConditions(table, conditions)
    const finalQuery = clause ? db.update(table).set(data).where(clause) : db.update(table).set(data)
    const { usedReturning, row } = await resolveWithReturning<TRecord>(finalQuery)
    if (usedReturning) return row as TRecord
    const result = await resolveMutation(finalQuery)
    return result as TRecord
  },

  // oxlint-disable-next-line no-unused-vars -- phantom type parameter, kept because it is part of the public signature
  async deleteAdvanced<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
    writeOptions?: AdapterQueryOptions,
  ): Promise<number | PlainObject | void> {
    const db = resolveExecutor(writeOptions)
    if (!db.delete) {
      throw new Error('DrizzleAdapter: configured database does not support deletes.')
    }

    const clause = buildDrizzleConditions(table, conditions)
    const finalQuery = clause ? db.delete(table).where(clause) : db.delete(table)
    const { usedReturning, row } = await resolveWithReturning<PlainObject>(finalQuery)
    if (usedReturning) return row
    const result = await resolveMutation(finalQuery)
    return result as number | PlainObject | void
  },

  async transaction<TResult>(callback: (trx: unknown) => Promise<TResult>): Promise<TResult> {
    const db = ensureDatabase()
    if (typeof db.transaction !== 'function') {
      throw new Error('DrizzleAdapter: configured database does not support transactions.')
    }
    return db.transaction(callback)
  },
}
