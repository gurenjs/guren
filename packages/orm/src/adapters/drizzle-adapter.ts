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
  groupBy?: (...columns: unknown[]) => DrizzleLikeSelect
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
// takes one transaction, so this serializes the ones this adapter drives.
let transactionQueue: Promise<unknown> = Promise.resolve()
// Outlives configure(): a new storage would lose the context of an open transaction.
let transactionScope: Promise<TransactionScope> | undefined
// The same scope once loaded, for the synchronous executor lookup: a callback
// only runs after transaction() awaited the load, so it is set whenever it matters.
let loadedTransactionScope: TransactionScope | undefined
// Savepoint names are generated, never taken from a caller.
let savepointSequence = 0

// Under SQLite's 999, the bound-variable limit of a build older than 3.32.
const CONSERVATIVE_IN_LIST_SIZE = 500
// Under the 65535 parameters Postgres and MySQL take per statement.
const POOLED_IN_LIST_SIZE = 5000

/**
 * Read from how the dialect escapes a parameter and a name, since this adapter
 * takes any drizzle-shaped handle and a driver list would name one it has never
 * heard of. A shape it cannot place keeps the conservative figure.
 */
function dialectInListSize(db: DrizzleDatabase): number {
  const dialect = (db as { dialect?: { escapeParam?(index: number): string; escapeName?(name: string): string } }).dialect
  try {
    if (dialect?.escapeParam?.(0) === '$1') return POOLED_IN_LIST_SIZE
    if (dialect?.escapeName?.('x') === '`x`') return POOLED_IN_LIST_SIZE
  } catch {
    /* empty */
  }
  return CONSERVATIVE_IN_LIST_SIZE
}

function ensureDatabase(): DrizzleDatabase {
  if (!database) {
    throw new Error('DrizzleAdapter: database has not been configured. Call DrizzleAdapter.configure(db).')
  }

  return database
}

/**
 * An explicit `trx` wins; without one, a call made inside a `transaction()`
 * callback runs on that transaction. Off the pool, on a driver whose pool is
 * `max: 1`, it would wait on the connection the open transaction holds. A
 * settled ambient is ignored: a continuation nobody awaited outlives the
 * transaction it was started in, and its handle is finalised by then.
 */
function resolveExecutor(options?: AdapterQueryOptions): DrizzleDatabase {
  if (options?.trx && typeof options.trx === 'object') {
    return options.trx as DrizzleDatabase
  }

  const ambient = loadedTransactionScope?.current()
  if (ambient && !ambient.settled && typeof ambient.handle === 'object' && ambient.handle !== null) {
    return ambient.handle as DrizzleDatabase
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

/**
 * Whether `db.transaction()` awaits its callback before committing: drizzle's
 * bun-sqlite COMMITs on whatever the callback returns, d1 and every pg/mysql
 * driver await it. Probed rather than matched against a driver list, because
 * this adapter takes any drizzle-shaped handle and one a list never named gets
 * the wrong path silently. Costs one empty transaction per configured database.
 */
async function awaitsItsCallback(db: DrizzleDatabase): Promise<boolean> {
  if (transactionAwaitsCallback === undefined) {
    const probe = db.transaction?.(NOOP as unknown as (trx: unknown) => Promise<undefined>)
    // Settling the probe only keeps its transaction from outliving this call; the
    // verdict is already recorded. Its failure must not stand in for the caller's
    // own — on a pooled driver the two hold different connections.
    transactionAwaitsCallback = isPromiseLike(probe)
    if (isPromiseLike(probe)) await probe.catch(NOOP)
  }

  return transactionAwaitsCallback
}

/**
 * The open transaction, as the async context carries it. `settled` is what tells
 * a live handle from one whose transaction has already committed or rolled back;
 * `nest` opens a scope inside it, a savepoint wherever the driver has one.
 */
interface AmbientTransaction {
  handle: unknown
  settled: boolean
  nest<TResult>(callback: (trx: unknown) => Promise<TResult>): Promise<TResult>
}

interface TransactionScope {
  /** Runs `fn` in a context where `current()` answers `entry`, for every await inside it. */
  run<TResult>(entry: AmbientTransaction, fn: () => TResult): TResult
  current(): AmbientTransaction | undefined
}

/**
 * Imported on demand so `node:async_hooks` stays off the module graph until a
 * transaction is opened (Workers needs `nodejs_compat` for it, as for
 * `node:crypto`). The promise is what is memoized, not the storage: two
 * concurrent first callers must not end up asking different instances.
 */
function loadTransactionScope(): Promise<TransactionScope> {
  transactionScope ??= import('node:async_hooks').then(({ AsyncLocalStorage }) => {
    const store = new AsyncLocalStorage<AmbientTransaction>()
    loadedTransactionScope = { run: (entry, fn) => store.run(entry, fn), current: () => store.getStore() }
    return loadedTransactionScope
  })

  return transactionScope
}

type OpenTransaction = NonNullable<DrizzleDatabase['transaction']>
type RunStatement = NonNullable<DrizzleDatabase['run']>

/**
 * Opened on the root database for a top-level call and on the open
 * transaction's own handle for a nested one, which is what makes drizzle emit
 * SAVEPOINT for the second. `settled` is set once the transaction itself has
 * finished, not once its callback has.
 */
async function runDriverTransaction<TResult>(
  open: OpenTransaction,
  scope: TransactionScope,
  callback: (trx: unknown) => Promise<TResult>,
): Promise<TResult> {
  let entry: AmbientTransaction | undefined
  try {
    return await open((trx) => {
      entry = driverEntry(trx, scope)
      return scope.run(entry, () => callback(trx))
    })
  } finally {
    if (entry) entry.settled = true
  }
}

function driverEntry(handle: unknown, scope: TransactionScope): AmbientTransaction {
  const open = (handle as DrizzleDatabase).transaction
  return {
    handle,
    settled: false,
    nest: (callback) =>
      typeof open === 'function'
        ? runDriverTransaction(open.bind(handle as DrizzleDatabase), scope, callback)
        : callback(handle),
  }
}

function manualEntry(db: DrizzleDatabase, run: RunStatement, scope: TransactionScope): AmbientTransaction {
  return { handle: db, settled: false, nest: (callback) => runSavepoint(db, run, scope, callback) }
}

/**
 * The savepoint the manual BEGIN/COMMIT path drives itself: this driver's own
 * `transaction()` commits before awaiting, so a nested call cannot go through
 * it. Savepoints do not pass through `transactionQueue`, so nested
 * transactions have to be awaited one at a time — two released out of order
 * discard each other's frames.
 */
async function runSavepoint<TResult>(
  db: DrizzleDatabase,
  run: RunStatement,
  scope: TransactionScope,
  callback: (trx: unknown) => Promise<TResult>,
): Promise<TResult> {
  const name = `guren_sp_${(savepointSequence += 1)}`
  await run(sql.raw(`savepoint ${name}`))

  const entry = manualEntry(db, run, scope)
  try {
    const result = await scope.run(entry, () => callback(db))
    await run(sql.raw(`release savepoint ${name}`))
    return result
  } catch (error) {
    try {
      await run(sql.raw(`rollback to savepoint ${name}`))
      await run(sql.raw(`release savepoint ${name}`))
    } catch {
      /* empty */
    }
    throw error
  } finally {
    entry.settled = true
  }
}

/**
 * Serializes what `runExclusively` drives, since one connection takes one
 * transaction. Only a caller outside every transaction may wait here: a nested
 * one would queue behind itself, which is why `transaction()` settles nesting
 * from the async context before reaching this queue.
 */
async function runOwnTransaction<TResult>(
  db: DrizzleDatabase,
  scope: TransactionScope,
  callback: (trx: unknown) => Promise<TResult>,
): Promise<TResult> {
  if (typeof db.run !== 'function') {
    throw new Error(
      'DrizzleAdapter: the configured database commits before its transaction callback has awaited anything, ' +
        'and exposes no run() to drive BEGIN/COMMIT with, so transactions on it cannot be made atomic.',
    )
  }

  // Bound: these are methods, and a detached one loses the dialect it reads.
  const run = db.run.bind(db)
  const slot = transactionQueue.then(() => runExclusively(db, run, scope, callback))
  // The queue only orders: a settled slot must neither reject the next one nor,
  // via a value-preserving `.catch`, pin its result until the next transaction.
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
  run: RunStatement,
  scope: TransactionScope,
  callback: (trx: unknown) => Promise<TResult>,
): Promise<TResult> {
  // Outside the try: a BEGIN that failed opened nothing to unwind.
  await run(sql.raw('begin'))

  const entry = manualEntry(db, run, scope)
  try {
    // Entered synchronously, which is what puts every await inside the callback
    // — and so any transaction it starts — in this transaction's async context.
    const result = await scope.run(entry, () => callback(db))
    await run(sql.raw('commit'))
    return result
  } catch (error) {
    // Reached by a refused COMMIT too, which leaves the transaction open. The
    // caller's error is what they have to see, so a failing ROLLBACK must not
    // replace it.
    try {
      await run(sql.raw('rollback'))
    } catch {
      /* empty */
    }
    throw error
  } finally {
    entry.settled = true
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
  },

  getDatabase<TDatabase extends DrizzleDatabase = DrizzleDatabase>(): TDatabase {
    return ensureDatabase() as unknown as TDatabase
  },

  maxInListSize(): number {
    return database ? dialectInListSize(database) : CONSERVATIVE_IN_LIST_SIZE
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

  async countByAdvanced(
    table: unknown,
    field: string,
    conditions: WhereCondition[],
    queryOptions?: AdapterQueryOptions,
  ): Promise<Array<{ key: unknown; count: number }>> {
    const db = resolveExecutor(queryOptions)
    const column = (table as DrizzleTableLike)[field]
    if (!column) {
      throw new Error(`DrizzleAdapter: unknown column "${field}" on provided table.`)
    }

    let query = db.select({ key: column, value: count() }).from(table)

    if (typeof query.where === 'function') {
      const clause = buildDrizzleConditions(table, conditions)
      if (clause) {
        query = query.where(clause) as DrizzleLikeSelect
      }
    }

    if (typeof query.groupBy !== 'function') {
      throw new Error('DrizzleAdapter: configured database does not support groupBy().')
    }
    query = query.groupBy(column)

    const rows = (await resolveList(query)) as Array<{ key: unknown; value?: unknown }>
    return rows.map(({ key, value }) => {
      const total = Number(value ?? 0)
      return { key, count: Number.isNaN(total) ? 0 : total }
    })
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

  /**
   * A nested call opens a savepoint inside the transaction already running
   * rather than a second top-level one: on a `max: 1` pool that second one
   * would wait on the connection the first holds, and on the single-connection
   * drivers it would queue behind itself. An inner throw the outer callback
   * catches therefore discards only the inner writes.
   */
  async transaction<TResult>(callback: (trx: unknown) => Promise<TResult>): Promise<TResult> {
    const db = ensureDatabase()
    if (typeof db.transaction !== 'function') {
      throw new Error('DrizzleAdapter: configured database does not support transactions.')
    }

    const scope = await loadTransactionScope()
    const ambient = scope.current()
    if (ambient && !ambient.settled) {
      return ambient.nest(callback)
    }

    if (await awaitsItsCallback(db)) {
      return runDriverTransaction(db.transaction.bind(db), scope, callback)
    }

    return runOwnTransaction(db, scope, callback)
  },
}
