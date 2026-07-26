import type { MySql2Database } from 'drizzle-orm/mysql2'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hotReloadKey, releaseActiveConnection, replaceActiveConnection } from './active-connections'
import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { buildMigrationStatus, describeConnectionEndpoint, describeDatabaseFailure, isConnectionFailure, migrationFailure, seedFailure, hasDrizzleMigrations, listLocalMigrations, warnIgnoredFlatSqlMigrations, type MigrationStatusEntry } from './migration-utils'
import { runSeeders } from './seeder'

type ConnectionResolver = string | (() => string | undefined)
type MySqlConnectionOptions = Record<string, unknown>
type MySql2Drizzle = typeof import('drizzle-orm/mysql2')
type MySql2Module = typeof import('mysql2')
type CreatePool = MySql2Module['createPool']
type MySqlPool = ReturnType<CreatePool>
type MySqlPoolOptions = Parameters<CreatePool>[0]
type DrizzleConfig = Exclude<Parameters<MySql2Drizzle['drizzle']>[0], string>

// The mysql driver packages are loaded lazily so importing @guren/orm
// does not require `mysql2` to be installed (e.g. SQLite-only apps).
async function loadMySqlModules(): Promise<{
  drizzle: MySql2Drizzle['drizzle']
  migrate: typeof import('drizzle-orm/mysql2/migrator')['migrate']
  createPool: CreatePool
}> {
  try {
    const [{ drizzle }, { migrate }, { createPool }] = await Promise.all([
      import('drizzle-orm/mysql2'),
      import('drizzle-orm/mysql2/migrator'),
      import('mysql2'),
    ])
    return { drizzle, migrate, createPool }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `createMySqlDatabase() requires the "mysql2" package. Install it with \`bun add mysql2\`. (${reason})`,
    )
  }
}

export interface MySqlDatabaseOptions {
  migrationsFolder: string | URL
  connectionString?: ConnectionResolver
  clientOptions?: MySqlConnectionOptions
  seedersFolder?: string | URL
  /**
   * Drizzle relations for RQB v2 (`db.query.*`).
   * Build with `defineRelations(schema, ...)` from `drizzle-orm`,
   * or with `relations()` from `drizzle-orm/_relations` for the RQB v1 partial-upgrade path.
   */
  relations?: Record<string, unknown>
}

export interface MySqlDatabase {
  getDatabase(): Promise<MySql2Database>
  migrateDatabase(): Promise<void>
  closeDatabase(): Promise<void>
  configureOrm(): Promise<void>
  seedDatabase(): Promise<void>
  /** Drops every table (including the drizzle migration tracker) so migrations can be re-applied from scratch. */
  resetDatabase(): Promise<void>
  /** Per-migration applied state derived from the drizzle-kit journal and the __drizzle_migrations table. */
  migrationStatus(): Promise<MigrationStatusEntry[]>
}

export function createMySqlDatabase(options: MySqlDatabaseOptions): MySqlDatabase {
  const { migrationsFolder, connectionString, clientOptions, seedersFolder, relations } = options

  const resolvedMigrationsFolder =
    migrationsFolder instanceof URL ? fileURLToPath(migrationsFolder) : resolve(String(migrationsFolder))
  const resolvedSeedersFolder =
    seedersFolder == null ? undefined : seedersFolder instanceof URL ? fileURLToPath(seedersFolder) : resolve(String(seedersFolder))

  let migrationsPromise: Promise<void> | undefined
  let databasePromise: Promise<MySql2Database> | undefined
  let client: MySqlPool | undefined
  let activeKey: string | undefined
  // Captured here, not in getDatabase(), so the caller of this factory is the
  // frame that identifies the handle across hot reloads.
  const callSite = new Error().stack

  function resolveConnectionString(): string {
    const value = typeof connectionString === 'function' ? connectionString() : connectionString
    const resolved = value ?? process.env.DATABASE_URL

    if (!resolved) {
      throw new Error('DATABASE_URL is not set and no connection string was provided.')
    }

    return resolved
  }

  // The pool is built here rather than handed to drizzle as `connection`:
  // drizzle's own wiring builds it through `mysql2/promise`, whose wrapper
  // exposes no `.config` for the driver to write `supportBigNumbers` onto, so
  // every query throws before reaching a socket. The callback-API pool it
  // accepts as `client` does expose one.
  function createClient(createPool: CreatePool, url: string): MySqlPool {
    return createPool({ uri: url, ...clientOptions } as MySqlPoolOptions)
  }

  async function migrateOnce(): Promise<void> {
    if (migrationsPromise) {
      return migrationsPromise
    }

    // Resolved inside the IIFE below: resolveConnectionString() throws when no
    // connection string is configured, so it must not run before the
    // no-migrations early return. The catch handler needs it afterwards.
    let endpoint: string | undefined

    const promise = (async (): Promise<void> => {
      if (!hasDrizzleMigrations(resolvedMigrationsFolder)) {
        warnIgnoredFlatSqlMigrations(resolvedMigrationsFolder)
        return
      }

      const { drizzle, migrate, createPool } = await loadMySqlModules()
      const url = resolveConnectionString()
      endpoint = describeConnectionEndpoint(url)
      const migrationClient = createClient(createPool, url)

      try {
        const migrationDb = drizzle({
          client: migrationClient,
          ...(relations ? { relations } : {}),
        } as DrizzleConfig)
        await migrate(migrationDb, { migrationsFolder: resolvedMigrationsFolder })
      } finally {
        await closePool(migrationClient)
      }
    })()

    migrationsPromise = promise.catch((error) => {
      migrationsPromise = undefined
      throw migrationFailure(error, endpoint)
    })

    await migrationsPromise
  }

  async function getDatabase(): Promise<MySql2Database> {
    if (databasePromise) {
      return databasePromise
    }

    const promise = (async (): Promise<MySql2Database> => {
      await migrateOnce()
      const { drizzle, createPool } = await loadMySqlModules()
      const url = resolveConnectionString()
      // Held locally as well as in closure state: a newer evaluation may close
      // this client while the await below is suspended, which clears `client`.
      const activeClient = createClient(createPool, url)
      client = activeClient

      activeKey = hotReloadKey('mysql', callSite, url)
      if (activeKey) {
        await replaceActiveConnection(activeKey, closeDatabase)
      }

      return drizzle({
        client: activeClient,
        ...(relations ? { relations } : {}),
      } as DrizzleConfig) as unknown as MySql2Database
    })()

    databasePromise = promise.catch((error) => {
      databasePromise = undefined
      throw error
    })

    return databasePromise
  }

  async function closeDatabase(): Promise<void> {
    if (!client) {
      return
    }

    const key = activeKey
    activeKey = undefined

    try {
      await closePool(client)
    } finally {
      client = undefined
      databasePromise = undefined
      if (key) {
        releaseActiveConnection(key, closeDatabase)
      }
    }
  }

  async function configureOrm(): Promise<void> {
    const db = await getDatabase()
    DrizzleAdapter.configure(db as unknown as Parameters<typeof DrizzleAdapter.configure>[0])
  }

  async function seedDatabase(): Promise<void> {
    if (!resolvedSeedersFolder) {
      throw new Error('No seeders folder configured. Provide "seedersFolder" when calling createMySqlDatabase().')
    }

    const db = await getDatabase()
    try {
      await runSeeders(db as unknown as Parameters<typeof runSeeders>[0], resolvedSeedersFolder)
    } catch (error) {
      throw seedFailure(error, describeConnectionEndpoint(resolveConnectionString()))
    }
  }

  async function withAdminDb<T>(callback: (db: MySql2Database) => Promise<T>): Promise<T> {
    const { drizzle, createPool } = await loadMySqlModules()
    const url = resolveConnectionString()
    const adminClient = createClient(createPool, url)
    const adminDb = drizzle({ client: adminClient } as DrizzleConfig) as unknown as MySql2Database

    try {
      return await callback(adminDb)
    } catch (error) {
      // Rethrowing raw would surface the driver's bare code with no message.
      throw new Error(describeDatabaseFailure(error, describeConnectionEndpoint(url)))
    } finally {
      await closePool(adminClient)
    }
  }

  async function resetDatabase(): Promise<void> {
    const { sql } = await import('drizzle-orm')

    await withAdminDb(async (adminDb) => {
      const [rows] = (await adminDb.execute(
        sql.raw('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()'),
      )) as unknown as [Array<{ name: string }>]

      await adminDb.execute(sql.raw('SET FOREIGN_KEY_CHECKS = 0'))
      try {
        for (const { name } of rows) {
          await adminDb.execute(sql.raw(`DROP TABLE IF EXISTS \`${name.replaceAll('`', '``')}\``))
        }
      } finally {
        await adminDb.execute(sql.raw('SET FOREIGN_KEY_CHECKS = 1'))
      }
    })

    // Allow migrateDatabase() to re-apply everything from scratch.
    migrationsPromise = undefined
  }

  async function migrationStatus(): Promise<MigrationStatusEntry[]> {
    const localMigrations = listLocalMigrations(resolvedMigrationsFolder)
    if (localMigrations.length === 0) return []

    const { sql } = await import('drizzle-orm')
    const appliedRows = await withAdminDb(async (adminDb) => {
      try {
        const [rows] = (await adminDb.execute(
          sql.raw('SELECT name, applied_at FROM __drizzle_migrations'),
        )) as unknown as [Array<{ name: string | null; applied_at: string | Date | null }>]
        return rows.map((row) => ({ name: row.name, appliedAt: row.applied_at }))
      } catch (error) {
        // An unreachable server reaches this catch too, and reporting it as
        // "nothing applied" makes db:status indistinguishable from a database
        // that is up with no migrations run.
        if (isConnectionFailure(error)) throw error
        // Tracker table does not exist yet — nothing applied.
        return []
      }
    })

    return buildMigrationStatus(localMigrations, appliedRows)
  }

  return {
    getDatabase,
    migrateDatabase: migrateOnce,
    closeDatabase,
    configureOrm,
    seedDatabase,
    resetDatabase,
    migrationStatus,
  }
}

async function closePool(pool: MySqlPool): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    pool.end((error) => {
      if (error) {
        rejectClose(error)
        return
      }
      resolveClose()
    })
  })
}

