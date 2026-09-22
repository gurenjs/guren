import { sql } from 'drizzle-orm'
import type { AsyncLocalStorage } from 'node:async_hooks'
import type { AdapterQueryOptions } from '../Model'
import { DEFAULT_IN_LIST_SIZE } from '../internal-keys'
import type { DrizzleDatabase } from './drizzle-types'
import { isPromiseLike } from './is-promise-like'

export interface ConnectionRuntime {
  readonly database: DrizzleDatabase
  executor(options?: AdapterQueryOptions): DrizzleDatabase
  run<T>(options: AdapterQueryOptions | undefined, callback: (db: DrizzleDatabase) => Promise<T>): Promise<T>
  transaction<T>(callback: (trx: unknown) => Promise<T>): Promise<T>
  queueExecution<TQuery>(query: TQuery, options?: AdapterQueryOptions): TQuery
  maxInListSize(): number
}

const connections = new WeakMap<DrizzleDatabase, ConnectionRuntime>()
let defaultConnection: ConnectionRuntime | undefined
let transactionStore: Promise<TransactionStore> | undefined
let loadedStore: TransactionStore | undefined

export function configureConnection(db: DrizzleDatabase): void {
  if (!db) {
    defaultConnection = undefined
    return
  }
  let connection = connections.get(db)
  if (!connection) {
    connection = createConnectionRuntime(db)
    connections.set(db, connection)
  }
  defaultConnection = connection
}

/** Reconfiguration changes the default, never the owner of an in-flight transaction. */
export function currentConnection(): ConnectionRuntime | undefined {
  return liveAmbient()?.owner ?? defaultConnection
}

/**
 * The transaction the async context carries, while it is still open; `owner`
 * narrows it to that runtime's own. A settled ambient is ignored: a
 * continuation nobody awaited outlives the transaction it was started in, and
 * its handle is finalised by then.
 */
function liveAmbient(owner?: ConnectionRuntime): AmbientTransaction | undefined {
  const ambient = loadedStore?.getStore()
  if (!ambient || ambient.settled) return undefined
  return owner && ambient.owner !== owner ? undefined : ambient
}

/**
 * The open transaction, as the async context carries it. `settled` is what tells
 * a live handle from one whose transaction has already committed or rolled back;
 * `nest` opens a scope inside it, a savepoint wherever the driver has one.
 */
interface AmbientTransaction {
  owner: ConnectionRuntime
  handle: unknown
  settled: boolean
  nest<TResult>(callback: (trx: unknown) => Promise<TResult>): Promise<TResult>
}

type TransactionStore = AsyncLocalStorage<AmbientTransaction>

/**
 * Imported on demand so `node:async_hooks` stays off the module graph until a
 * transaction is opened (Workers needs `nodejs_compat` for it, as for
 * `node:crypto`). The promise is what is memoized, not the storage: two
 * concurrent first callers must not end up asking different instances.
 */
function loadTransactionStore(): Promise<TransactionStore> {
  transactionStore ??= import('node:async_hooks').then(({ AsyncLocalStorage }) => {
    loadedStore = new AsyncLocalStorage<AmbientTransaction>()
    return loadedStore
  })

  return transactionStore
}

// Under the 65535 parameters Postgres and MySQL take per statement.
const POOLED_IN_LIST_SIZE = 5000

const SYNC_EXECUTIONS = ['all', 'get', 'run', 'values'] as const
const NOOP = () => undefined

type OpenTransaction = NonNullable<DrizzleDatabase['transaction']>
type RunStatement = NonNullable<DrizzleDatabase['run']>

// `typeof === 'function'` narrows to `Function`, whose apply() returns `any`.
function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function'
}

function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { configurable: true, writable: true, value })
}

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
  return DEFAULT_IN_LIST_SIZE
}

function createConnectionRuntime(db: DrizzleDatabase): ConnectionRuntime {
  let transactionAwaitsCallback: boolean | undefined
  let inListSize: number | undefined
  let transactionQueue: Promise<unknown> = Promise.resolve()
  const pendingOperations = new Set<Promise<unknown>>()
  let manualTransactionOpen = false
  let savepointSequence = 0

  /**
   * An explicit `trx` wins; without one, a call made inside a `transaction()`
   * callback runs on that transaction. Off the pool, on a driver whose pool is
   * `max: 1`, it would wait on the connection the open transaction holds.
   */
  function resolveExecutor(options?: AdapterQueryOptions): DrizzleDatabase {
    if (options?.trx && typeof options.trx === 'object') {
      return options.trx as DrizzleDatabase
    }

    const handle = liveAmbient(runtime)?.handle
    if (typeof handle === 'object' && handle !== null) {
      return handle as DrizzleDatabase
    }

    return db
  }

  function withExecutor<T>(options: AdapterQueryOptions | undefined, callback: (db: DrizzleDatabase) => Promise<T>): Promise<T> {
    if (options?.trx || liveAmbient(runtime)) return callback(resolveExecutor(options))
    if (transactionAwaitsCallback === false) {
      const operation = transactionQueue.then(() => callback(db))
      transactionQueue = operation.then(NOOP, NOOP)
      return operation
    }
    const operation = callback(db)
    if (transactionAwaitsCallback === undefined) {
      pendingOperations.add(operation)
      const forget = () => pendingOperations.delete(operation)
      void operation.then(forget, forget)
    }
    return operation
  }

  /** A BEGIN this adapter issued is on the connection, and the caller is not inside it. */
  function foreignTransactionOpen(): boolean {
    return manualTransactionOpen && !liveAmbient(runtime)
  }

  /**
   * `then` reaches drizzle's `execute()`, so replacing it on the instance routes
   * every await through `withExecutor`. `all()`/`get()`/`run()`/`values()` return
   * synchronously on bun:sqlite and cannot wait: during a transaction another
   * context holds they would run inside it, so they throw instead. A prepared
   * statement executes later, so it gets the same treatment.
   */
  function queueQuery<TQuery>(query: TQuery, queryOptions: AdapterQueryOptions | undefined): TQuery {
    if (!query || typeof query !== 'object') return query
    const target = query as Record<string, unknown>
    const { execute, prepare } = target
    if (isCallable(execute)) {
      // async: drizzle's lazy result becomes a Promise, and a synchronous throw a rejection.
      define(target, 'execute', (...args: unknown[]) => withExecutor(queryOptions, async () => execute.apply(target, args)))
    }
    if (isCallable(prepare)) {
      define(target, 'prepare', (...args: unknown[]) => queueQuery(prepare.apply(target, args), queryOptions))
    }
    for (const method of SYNC_EXECUTIONS) {
      const run = target[method]
      if (!isCallable(run)) continue
      define(target, method, (...args: unknown[]) => {
        if (foreignTransactionOpen()) {
          throw new Error(
            `DrizzleAdapter: ${method}() cannot wait for the transaction another context has open on this connection, and would run inside it. Await the query instead.`,
          )
        }
        return run.apply(target, args)
      })
    }
    return query
  }

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
   * Opened on the root database for a top-level call and on the open
   * transaction's own handle for a nested one, which is what makes drizzle emit
   * SAVEPOINT for the second. `settled` is set once the transaction itself has
   * finished, not once its callback has.
   */
  async function runDriverTransaction<TResult>(
    open: OpenTransaction,
    store: TransactionStore,
    callback: (trx: unknown) => Promise<TResult>,
  ): Promise<TResult> {
    let entry: AmbientTransaction | undefined
    try {
      return await open((trx) => {
        entry = driverEntry(trx, store)
        return store.run(entry, () => callback(trx))
      })
    } finally {
      if (entry) entry.settled = true
    }
  }

  function driverEntry(handle: unknown, store: TransactionStore): AmbientTransaction {
    const open = (handle as DrizzleDatabase).transaction
    return {
      owner: runtime,
      handle,
      settled: false,
      nest: (callback) =>
        typeof open === 'function'
          ? runDriverTransaction(open.bind(handle as DrizzleDatabase), store, callback)
          : callback(handle),
    }
  }

  function manualEntry(run: RunStatement, store: TransactionStore): AmbientTransaction {
    return { owner: runtime, handle: db, settled: false, nest: (callback) => runSavepoint(run, store, callback) }
  }

  /**
   * The savepoint the manual BEGIN/COMMIT path drives itself: this driver's own
   * `transaction()` commits before awaiting, so a nested call cannot go through
   * it. Savepoints do not pass through `transactionQueue`, so nested
   * transactions have to be awaited one at a time — two released out of order
   * discard each other's frames.
   */
  async function runSavepoint<TResult>(
    run: RunStatement,
    store: TransactionStore,
    callback: (trx: unknown) => Promise<TResult>,
  ): Promise<TResult> {
    const name = `guren_sp_${(savepointSequence += 1)}`
    // Outside enterTransaction: a SAVEPOINT that failed opened nothing to unwind.
    await run(sql.raw(`savepoint ${name}`))

    return enterTransaction(run, store, callback, {
      commit: [`release savepoint ${name}`],
      rollback: [`rollback to savepoint ${name}`, `release savepoint ${name}`],
    })
  }

  /**
   * The lifecycle both hand-driven paths share, from the statement that opened the
   * transaction to the one that settles it. The entry is entered synchronously,
   * which is what puts every await inside the callback — and so any transaction it
   * starts — in this transaction's async context.
   */
  async function enterTransaction<TResult>(
    run: RunStatement,
    store: TransactionStore,
    callback: (trx: unknown) => Promise<TResult>,
    settle: { commit: readonly string[]; rollback: readonly string[] },
  ): Promise<TResult> {
    const entry = manualEntry(run, store)
    try {
      const result = await store.run(entry, () => callback(db))
      for (const statement of settle.commit) await run(sql.raw(statement))
      return result
    } catch (error) {
      // Reached by a refused COMMIT too, which leaves the transaction open. The
      // caller's error is what they have to see, so a failing ROLLBACK must not
      // replace it.
      try {
        for (const statement of settle.rollback) await run(sql.raw(statement))
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
  async function runOwnTransaction<TResult>(store: TransactionStore, callback: (trx: unknown) => Promise<TResult>): Promise<TResult> {
    if (typeof db.run !== 'function') {
      throw new Error(
        'DrizzleAdapter: the configured database commits before its transaction callback has awaited anything, ' +
          'and exposes no run() to drive BEGIN/COMMIT with, so transactions on it cannot be made atomic.',
      )
    }

    // Bound: these are methods, and a detached one loses the dialect it reads.
    const run = db.run.bind(db)
    const pending = [...pendingOperations]
    const slot = transactionQueue.then(async () => {
      await Promise.allSettled(pending)
      return runExclusively(run, store, callback)
    })
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
    run: RunStatement,
    store: TransactionStore,
    callback: (trx: unknown) => Promise<TResult>,
  ): Promise<TResult> {
    // Outside enterTransaction: a BEGIN that failed opened nothing to unwind.
    manualTransactionOpen = true
    try {
      await run(sql.raw('begin'))
      return await enterTransaction(run, store, callback, { commit: ['commit'], rollback: ['rollback'] })
    } finally {
      manualTransactionOpen = false
    }
  }

  const runtime: ConnectionRuntime = {
    database: db,
    executor: resolveExecutor,
    run: withExecutor,
    queueExecution<TQuery>(query: TQuery, options?: AdapterQueryOptions): TQuery {
      if (options?.trx || transactionAwaitsCallback === true) return query
      return queueQuery(query, options)
    },
    maxInListSize() {
      inListSize ??= dialectInListSize(db)
      return inListSize
    },
    async transaction<TResult>(callback: (trx: unknown) => Promise<TResult>): Promise<TResult> {
      if (typeof db.transaction !== 'function') {
        throw new Error('DrizzleAdapter: configured database does not support transactions.')
      }

      const store = await loadTransactionStore()
      const ambient = liveAmbient(runtime)
      if (ambient) return ambient.nest(callback)

      if (await awaitsItsCallback(db)) {
        return runDriverTransaction(db.transaction.bind(db), store, callback)
      }

      return runOwnTransaction(store, callback)
    },
  }
  return runtime
}
