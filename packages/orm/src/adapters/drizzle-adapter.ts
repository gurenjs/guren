import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
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
  run?(query: unknown): Promise<unknown>
  transaction?<TResult>(callback: (trx: unknown) => Promise<TResult>): Promise<TResult>
}

let database: DrizzleDatabase | undefined
// Memo for the configured `database` only; `configure()` clears it. Module state
// outlives a test file, and `bun test packages/orm` runs them in one process.
let transactionAwaitsCallback: boolean | undefined
// Only for a database whose own transaction() does not await: one connection
// takes one transaction, so these serialize the ones this adapter drives.
let transactionQueue: Promise<unknown> = Promise.resolve()
let transactionOpen = false

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

const NOOP = () => undefined
const NOOP_TRANSACTION = NOOP as unknown as (trx: unknown) => Promise<undefined>

/**
 * Whether `db.transaction()` awaits its callback before committing: drizzle's
 * bun-sqlite COMMITs on whatever the callback returns, d1 and every pg/mysql
 * driver await it. Probed rather than matched against a driver list, because
 * this adapter takes any drizzle-shaped handle and one a list never named gets
 * the wrong path silently. Costs one empty transaction per configured database.
 */
async function awaitsItsCallback(db: DrizzleDatabase): Promise<boolean> {
  if (transactionAwaitsCallback === undefined) {
    const probe = db.transaction?.(NOOP_TRANSACTION)
    // The verdict is the shape of the return value, so it is already known here.
    // Settling the probe only keeps its transaction from outliving this call, and
    // its failure must not stand in for the caller's own — on a pooled driver the
    // two hold different connections.
    transactionAwaitsCallback = isPromiseLike(probe)
    if (isPromiseLike(probe)) await probe.catch(NOOP)
  }

  return transactionAwaitsCallback
}

/**
 * Serializes what `runExclusively` drives, since one connection takes one
 * transaction. Queueing is only safe for a caller that is not already inside
 * one — that caller would be waiting on itself — and `transactionOpen` is what
 * separates the two: a queued caller is suspended at its await and cannot be
 * running this, so a set flag means the call arrived while a transaction was live.
 */
async function runOwnTransaction<TResult>(
  db: DrizzleDatabase,
  callback: (trx: unknown) => Promise<TResult>,
): Promise<TResult> {
  if (typeof db.run !== 'function') {
    throw new Error(
      'DrizzleAdapter: the configured database commits before its transaction callback has awaited anything, ' +
        'and exposes no run() to drive BEGIN/COMMIT with, so transactions on it cannot be made atomic.',
    )
  }

  if (transactionOpen) {
    throw new Error(
      'DrizzleAdapter: cannot begin a transaction while one is already open. This driver holds a single ' +
        'connection, which takes one transaction at a time: do not nest transactions, and do not await ' +
        'non-database work inside one.',
    )
  }

  // Bound: these are methods, and a detached one loses the dialect it reads.
  const run = db.run.bind(db)
  const slot = transactionQueue.then(() => runExclusively(db, run, callback))
  // The queue only orders; a rejected slot must not reject the next one.
  transactionQueue = slot.then(NOOP, NOOP)
  return slot
}

/**
 * BEGIN/COMMIT/ROLLBACK driven here so an async callback is honoured on a driver
 * that would otherwise commit before awaiting it. The handle itself is the
 * transaction scope: these drivers hold one connection, so every statement
 * between BEGIN and COMMIT is inside it. Callers reach this one at a time.
 */
async function runExclusively<TResult>(
  db: DrizzleDatabase,
  run: NonNullable<DrizzleDatabase['run']>,
  callback: (trx: unknown) => Promise<TResult>,
): Promise<TResult> {
  await run(sql.raw('begin'))
  transactionOpen = true

  let result: TResult
  try {
    result = await callback(db)
  } catch (error) {
    // The callback's error is what the caller has to see, so a failing
    // ROLLBACK must not replace it.
    await unwind(run)
    throw error
  }

  try {
    await run(sql.raw('commit'))
    transactionOpen = false
  } catch (error) {
    // A refused COMMIT leaves the transaction open, and the next caller would
    // inherit one this call never left behind.
    await unwind(run)
    throw error
  }

  return result
}

/** Ends the open transaction without letting its own failure mask the caller's. */
async function unwind(run: NonNullable<DrizzleDatabase['run']>): Promise<void> {
  try {
    await run(sql.raw('rollback'))
  } catch {
    /* empty */
  } finally {
    transactionOpen = false
  }
}

export const DrizzleAdapter: ORMAdapterAdvanced & {
  configure(db: DrizzleDatabase): void
  getDatabase<TDatabase extends DrizzleDatabase = DrizzleDatabase>(): TDatabase
} = {
  configure(db: DrizzleDatabase) {
    database = db
    transactionAwaitsCallback = undefined
    transactionQueue = Promise.resolve()
    transactionOpen = false
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

    if (typeof query.where === 'function') {
      const clause = buildDrizzleConditions(table, conditions)
      if (clause) {
        query = query.where(clause) as DrizzleLikeSelect
      }
    }

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

    if (await awaitsItsCallback(db)) {
      return db.transaction(callback)
    }

    return runOwnTransaction(db, callback)
  },
}
