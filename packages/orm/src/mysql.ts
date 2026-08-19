import type { MySql2Database } from 'drizzle-orm/mysql2'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hotReloadKey, releaseActiveConnection, replaceActiveConnection } from './active-connections'
import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { buildMigrationStatus, describeConnectionEndpoint, describeDatabaseFailure, isConnectionFailure, migrationFailure, seedFailure, listLocalMigrations, noMigrationsToRun, type MigrationRunSummary, type MigrationStatusEntry } from './migration-utils'
import { runSeeders } from './seeder'
import { singleFlight } from './single-flight'

type ConnectionResolver = string | (() => string | undefined)
type MySqlConnectionOptions = Record<string, unknown>
type MySql2Drizzle = typeof import('drizzle-orm/mysql2')
type CreatePool = typeof import('mysql2')['createPool']
type MySqlPool = ReturnType<CreatePool>
type DrizzleConfig = Exclude<Parameters<MySql2Drizzle['drizzle']>[0], string>

// The mysql driver packages are loaded lazily so importing @guren/orm
// does not require `mysql2` to be installed (e.g. SQLite-only apps).
//
// `createPool` comes from mysql2's callback API on purpose: drizzle builds its
// own pool through `mysql2/promise` when handed a `connection:`, and that
// wrapper exposes no `.config` for the driver to write `supportBigNumbers`
// onto, so every query throws before reaching a socket. Pools built here are
// passed to `drizzle({ client })` instead.
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
  /** Applies pending drizzle-kit migrations and reports what the folder held. */
  migrateDatabase(): Promise<MigrationRunSummary>
  closeDatabase(): Promise<void>
  configureOrm(): Promise<void>
  seedDatabase(): Promise<void>
  /** Drops every table and view (including the drizzle migration tracker), then re-applies migrations — same end state as `guren db:reset`. */
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

  let client: MySqlPool | undefined
  let activeKey: string | undefined
  // Captured here, not in the connection factory, so the caller of this factory
  // is the frame that identifies the handle across hot reloads.
  const callSite = new Error().stack

  function resolveConnectionString(): string {
    const value = typeof connectionString === 'function' ? connectionString() : connectionString
    const resolved = value ?? process.env.DATABASE_URL

    if (!resolved) {
      throw new Error('DATABASE_URL is not set and no connection string was provided.')
    }

    return resolved
  }

  const migrations = singleFlight(async (): Promise<MigrationRunSummary> => {
    // Scoped to this attempt, and resolved below rather than up front:
    // resolveConnectionString() throws when no connection string is configured,
    // so it must not run before the no-migrations early return. The catch needs
    // it afterwards.
    let endpoint: string | undefined

    try {
      const localMigrations = listLocalMigrations(resolvedMigrationsFolder)
      if (localMigrations.length === 0) {
        return noMigrationsToRun(resolvedMigrationsFolder)
      }

      const { drizzle, migrate, createPool } = await loadMySqlModules()
      const url = resolveConnectionString()
      endpoint = describeConnectionEndpoint(url)
      const migrationClient = createPool({ uri: url, ...clientOptions })

      try {
        const migrationDb = drizzle({
          client: migrationClient,
          ...(relations ? { relations } : {}),
        } as DrizzleConfig)
        await migrate(migrationDb, { migrationsFolder: resolvedMigrationsFolder })
      } finally {
        await closePool(migrationClient)
      }

      return { migrationsFolder: resolvedMigrationsFolder, migrationsFound: localMigrations.length, looseSqlFiles: 0 }
    } catch (error) {
      throw migrationFailure(error, endpoint)
    }
  })

  const database = singleFlight(async (): Promise<MySql2Database> => {
    await migrations.get()
    const { drizzle, createPool } = await loadMySqlModules()
    const url = resolveConnectionString()
    // Held locally as well as in closure state: a newer evaluation may close
    // this client while the await below is suspended, which clears `client`.
    const activeClient = createPool({ uri: url, ...clientOptions })
    client = activeClient

    activeKey = hotReloadKey('mysql', callSite, url)
    if (activeKey) {
      await replaceActiveConnection(activeKey, closeDatabase)
    }

    return drizzle({
      client: activeClient,
      ...(relations ? { relations } : {}),
    } as DrizzleConfig) as unknown as MySql2Database
  })

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
      database.reset()
      if (key) {
        releaseActiveConnection(key, closeDatabase)
      }
    }
  }

  async function configureOrm(): Promise<void> {
    const db = await database.get()
    DrizzleAdapter.configure(db as unknown as Parameters<typeof DrizzleAdapter.configure>[0])
  }

  async function seedDatabase(): Promise<void> {
    if (!resolvedSeedersFolder) {
      throw new Error('No seeders folder configured. Provide "seedersFolder" when calling createMySqlDatabase().')
    }

    const db = await database.get()
    try {
      await runSeeders(db, resolvedSeedersFolder)
    } catch (error) {
      throw seedFailure(error, describeConnectionEndpoint(resolveConnectionString()))
    }
  }

  async function withAdminDb<T>(callback: (db: MySql2Database) => Promise<T>): Promise<T> {
    const { drizzle, createPool } = await loadMySqlModules()
    const url = resolveConnectionString()
    const adminClient = createPool({ uri: url, ...clientOptions })
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
      // table_type is selected because information_schema.tables lists views
      // alongside base tables, and MySQL answers DROP TABLE on a view with a
      // warning rather than an error — so dropping every row as a table
      // silently leaves views standing behind a successful-looking reset.
      const [rows] = (await adminDb.execute(
        sql.raw(
          'SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = DATABASE()',
        ),
      )) as unknown as [Array<{ name: string; type: string }>]

      await adminDb.execute(sql.raw('SET FOREIGN_KEY_CHECKS = 0'))
      try {
        for (const { name, type } of rows) {
          const identifier = sql.identifier(name)
          await adminDb.execute(
            type === 'VIEW' ? sql`DROP VIEW IF EXISTS ${identifier}` : sql`DROP TABLE IF EXISTS ${identifier}`,
          )
        }
      } finally {
        await adminDb.execute(sql.raw('SET FOREIGN_KEY_CHECKS = 1'))
      }
    })

    // Drop the memo so the run below re-applies everything from scratch, then
    // migrate: a reset ends on a migrated database, the same state `guren
    // db:reset` leaves behind. A caller that migrates again — the documented
    // reset-then-migrate pattern — hits the memo and no-ops.
    migrations.reset()
    await migrations.get()
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
    getDatabase: database.get,
    migrateDatabase: migrations.get,
    closeDatabase,
    configureOrm,
    seedDatabase,
    resetDatabase,
    migrationStatus,
  }
}

async function closePool(pool: MySqlPool): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    pool.end((error) => (error ? rejectClose(error) : resolveClose()))
  })
}

