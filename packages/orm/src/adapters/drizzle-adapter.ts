import { and, asc, count, desc, eq, inArray, isNull, max, min, sql } from 'drizzle-orm'
import type { AnyColumn } from 'drizzle-orm'
import { DEFAULT_IN_LIST_SIZE } from '../internal-keys'
import type { AdapterQueryOptions, FindManyOptions, OrderByClause, PlainObject, WhereClause } from '../Model'
import type { AggregateFunction, ORMAdapterAdvanced, WhereCondition } from '../QueryBuilder'
import { buildDrizzleConditions, resolveColumn } from './drizzle-conditions'
import { configureConnection, currentConnection } from './drizzle-connection'
import type { DrizzleDatabase, DrizzleLikeSelect, DrizzleLikeInsertResult, DrizzleLikeUpdate, DrizzleLikeDelete } from './drizzle-types'
import { isPromiseLike } from './is-promise-like'

function withConditions(query: DrizzleLikeSelect, table: unknown, conditions: WhereCondition[]): DrizzleLikeSelect {
  if (typeof query.where !== 'function') return query
  const clause = buildDrizzleConditions(table, conditions)
  return clause ? (query.where(clause) as DrizzleLikeSelect) : query
}

/** Drivers report a count as a number, a bigint or a decimal string. */
function toCount(value: unknown): number {
  const total = Number(value ?? 0)
  return Number.isNaN(total) ? 0 : total
}

/** A drizzle 1.x column's `dataType` leads with its JS kind (`number int32`, `string numeric`); 0.x has only the kind. */
function columnKind(column: unknown): string {
  const dataType = (column as { dataType?: unknown }).dataType
  return typeof dataType === 'string' ? dataType.split(' ')[0] : ''
}

/**
 * Drivers disagree on an aggregate's wire type (postgres-js and mysql2 send
 * `sum(int)` as a decimal string, bun:sqlite as a number), so the column's kind
 * decides, never the driver.
 */
function decodeAggregate(fn: AggregateFunction, column: unknown, field: string, raw: unknown): unknown {
  const kind = columnKind(column)
  if (raw === null || raw === undefined) {
    if (fn !== 'sum') return null
    return kind === 'bigint' ? 0n : kind === 'string' ? '0' : 0
  }

  if (kind === 'number') {
    const value = Number(raw)
    // Only an integer literal can be rounded by Number(); a float column's large total is a legitimate value.
    if (typeof raw === 'string' && /^-?\d+$/.test(raw) && !Number.isSafeInteger(value)) {
      throw new RangeError(
        `DrizzleAdapter: ${fn}("${field}") is ${String(raw)}, past Number.MAX_SAFE_INTEGER; declare the column with mode: 'bigint'.`,
      )
    }
    return value
  }
  if (kind === 'bigint') {
    return fn === 'avg' ? String(raw) : typeof raw === 'bigint' ? raw : BigInt(String(raw))
  }
  if (kind === 'string') return String(raw)
  return raw
}

function connection() {
  const runtime = currentConnection()
  if (!runtime) throw new Error('DrizzleAdapter: database has not been configured. Call DrizzleAdapter.configure(db).')
  return runtime
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

/**
 * Eagerly call `.returning()` if available: bun-sqlite's query builders are
 * thenable, so `resolveMutation`'s `isPromiseLike` check would otherwise win
 * first and the driver would hand back a RunResult instead of rows.
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
  configure: configureConnection,

  getDatabase<TDatabase extends DrizzleDatabase = DrizzleDatabase>(): TDatabase {
    return connection().database as TDatabase
  },

  maxInListSize(): number {
    return currentConnection()?.maxInListSize() ?? DEFAULT_IN_LIST_SIZE
  },

  async findMany<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    options?: FindManyOptions<TRecord>,
    queryOptions?: AdapterQueryOptions,
  ): Promise<TRecord[]> {
    return connection().run(queryOptions, async (db) => {
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
    })
  },

  async count<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where?: WhereClause<TRecord>,
    queryOptions?: AdapterQueryOptions,
  ): Promise<number> {
    return connection().run(queryOptions, async (db) => {
      let query = db.select({ value: count() }).from(table)

      if (typeof query.where === 'function') {
        const clause = resolveWhere(table, where)
        if (clause) {
          query = query.where(clause) as DrizzleLikeSelect
        }
      }

      const rows = await resolveList(query)
      return toCount((rows[0] as { value?: unknown } | undefined)?.value)
    })
  },

  async findUnique<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
    queryOptions?: AdapterQueryOptions,
  ): Promise<TRecord | null> {
    return connection().run(queryOptions, async (db) => {
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
    })
  },

  async create<TRecord = PlainObject>(
    table: unknown,
    data: PlainObject,
    writeOptions?: AdapterQueryOptions,
  ): Promise<TRecord> {
    return connection().run(writeOptions, async (db) => {
      const query = db.insert(table).values(data)
      const { usedReturning, row } = await resolveWithReturning<TRecord>(query)
      if (usedReturning) return row as TRecord
      const result = await resolveMutation(query)
      return result as TRecord
    })
  },

  async update<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
    data: PlainObject,
    writeOptions?: AdapterQueryOptions,
  ): Promise<TRecord> {
    return connection().run(writeOptions, async (db) => {
      if (!db.update) {
        throw new Error('DrizzleAdapter: configured database does not support updates.')
      }

      const clause = resolveWhere(table, where)
      const finalQuery = clause ? db.update(table).set(data).where(clause) : db.update(table).set(data)
      const { usedReturning, row } = await resolveWithReturning<TRecord>(finalQuery)
      if (usedReturning) return row as TRecord
      const result = await resolveMutation(finalQuery)
      return result as TRecord
    })
  },

  async delete<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
    writeOptions?: AdapterQueryOptions,
  ): Promise<number | PlainObject | void> {
    return connection().run(writeOptions, async (db) => {
      if (!db.delete) {
        throw new Error('DrizzleAdapter: configured database does not support deletes.')
      }

      const clause = resolveWhere(table, where)
      const finalQuery = clause ? db.delete(table).where(clause) : db.delete(table)
      const { usedReturning, row } = await resolveWithReturning<PlainObject>(finalQuery)
      if (usedReturning) return row
      const result = await resolveMutation(finalQuery)
      return result as number | PlainObject | void
    })
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
    return connection().run(queryOptions, async (db) => {
      const tableRecord = table as DrizzleTableLike

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

      query = withConditions(query, table, conditions)

      if (typeof query.orderBy === 'function') {
        const clauses = resolveOrder(table, options.orderBy)
        if (clauses && clauses.length > 0) {
          query = query.orderBy(...clauses) as DrizzleLikeSelect
        }
      }

      if (typeof query.limit === 'function' && typeof options.limit === 'number') {
        query = query.limit(options.limit) as DrizzleLikeSelect
      }

      if (typeof query.offset === 'function' && typeof options.offset === 'number') {
        query = query.offset(options.offset) as DrizzleLikeSelect
      }

      const rows = await resolveList(query)
      return rows as TRecord[]
    })
  },

  // oxlint-disable-next-line no-unused-vars -- phantom type parameter, kept because it is part of the public signature
  async countAdvanced<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
    queryOptions?: AdapterQueryOptions,
  ): Promise<number> {
    return connection().run(queryOptions, async (db) => {
      const query = withConditions(db.select({ value: count() }).from(table), table, conditions)
      const rows = await resolveList(query)
      return toCount((rows[0] as { value?: unknown } | undefined)?.value)
    })
  },

  async aggregateAdvanced(
    table: unknown,
    fn: AggregateFunction,
    field: string,
    conditions: WhereCondition[],
    queryOptions?: AdapterQueryOptions,
  ): Promise<unknown> {
    return connection().run(queryOptions, async (db) => {
      const column = resolveColumn(table, field)
      const expression = fn === 'min' ? min(column) : fn === 'max' ? max(column) : sql`${sql.raw(fn)}(${column})`
      const query = withConditions(db.select({ value: expression }).from(table), table, conditions)
      const rows = (await resolveList(query)) as Array<{ value?: unknown }>
      return decodeAggregate(fn, column, field, rows[0]?.value ?? null)
    })
  },

  executor(queryOptions?: AdapterQueryOptions): unknown {
    return connection().executor(queryOptions)
  },

  queueExecution<TQuery>(query: TQuery, queryOptions?: AdapterQueryOptions): TQuery {
    return connection().queueExecution(query, queryOptions)
  },

  async countByAdvanced(
    table: unknown,
    field: string,
    conditions: WhereCondition[],
    queryOptions?: AdapterQueryOptions,
  ): Promise<Array<{ key: unknown; count: number }>> {
    return connection().run(queryOptions, async (db) => {
      const column = (table as DrizzleTableLike)[field]
      if (!column) {
        throw new Error(`DrizzleAdapter: unknown column "${field}" on provided table.`)
      }

      let query = withConditions(db.select({ key: column, value: count() }).from(table), table, conditions)

      if (typeof query.groupBy !== 'function') {
        throw new Error('DrizzleAdapter: configured database does not support groupBy().')
      }
      query = query.groupBy(column)

      const rows = (await resolveList(query)) as Array<{ key: unknown; value?: unknown }>
      return rows.map(({ key, value }) => ({ key, count: toCount(value) }))
    })
  },

  async updateAdvanced<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
    data: PlainObject,
    writeOptions?: AdapterQueryOptions,
  ): Promise<TRecord> {
    return connection().run(writeOptions, async (db) => {
      if (!db.update) {
        throw new Error('DrizzleAdapter: configured database does not support updates.')
      }

      const clause = buildDrizzleConditions(table, conditions)
      const finalQuery = clause ? db.update(table).set(data).where(clause) : db.update(table).set(data)
      const { usedReturning, row } = await resolveWithReturning<TRecord>(finalQuery)
      if (usedReturning) return row as TRecord
      const result = await resolveMutation(finalQuery)
      return result as TRecord
    })
  },

  // oxlint-disable-next-line no-unused-vars -- phantom type parameter, kept because it is part of the public signature
  async deleteAdvanced<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
    writeOptions?: AdapterQueryOptions,
  ): Promise<number | PlainObject | void> {
    return connection().run(writeOptions, async (db) => {
      if (!db.delete) {
        throw new Error('DrizzleAdapter: configured database does not support deletes.')
      }

      const clause = buildDrizzleConditions(table, conditions)
      const finalQuery = clause ? db.delete(table).where(clause) : db.delete(table)
      const { usedReturning, row } = await resolveWithReturning<PlainObject>(finalQuery)
      if (usedReturning) return row
      const result = await resolveMutation(finalQuery)
      return result as number | PlainObject | void
    })
  },

  async transaction<TResult>(callback: (trx: unknown) => Promise<TResult>): Promise<TResult> {
    return connection().transaction(callback)
  },
}
