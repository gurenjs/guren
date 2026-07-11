import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { buildMigrationStatus, hasDrizzleMigrations, listLocalMigrations, warnIgnoredFlatSqlMigrations, type MigrationStatusEntry } from './migration-utils'
import { runSeeders } from './seeder'

type ConnectionResolver = string | (() => string | undefined)
type MySqlConnectionOptions = Record<string, unknown>
type DrizzleConfig = Exclude<Parameters<typeof drizzle>[0], string>

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
  let database: MySql2Database | undefined

  function resolveConnectionString(): string {
    const value = typeof connectionString === 'function' ? connectionString() : connectionString
    const resolved = value ?? process.env.DATABASE_URL

    if (!resolved) {
      throw new Error('DATABASE_URL is not set and no connection string was provided.')
    }

    return resolved
  }

  async function migrateOnce(): Promise<void> {
    if (migrationsPromise) {
      return migrationsPromise
    }

    const promise = (async (): Promise<void> => {
      if (!hasDrizzleMigrations(resolvedMigrationsFolder)) {
        warnIgnoredFlatSqlMigrations(resolvedMigrationsFolder)
        return
      }

      const url = resolveConnectionString()
      const migrationDb = drizzle({
        connection: {
          uri: url,
          ...clientOptions,
        },
        mode: 'default',
        ...(relations ? { relations } : {}),
      } as DrizzleConfig)

      try {
        await migrate(migrationDb, { migrationsFolder: resolvedMigrationsFolder })
      } finally {
        await closeClient(migrationDb)
      }
    })()

    migrationsPromise = promise.catch((error) => {
      migrationsPromise = undefined
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to run database migrations: ${reason}`)
    })

    await migrationsPromise
  }

  async function getDatabase(): Promise<MySql2Database> {
    if (databasePromise) {
      return databasePromise
    }

    const promise = (async (): Promise<MySql2Database> => {
      await migrateOnce()
      const url = resolveConnectionString()
      const db = drizzle({
        connection: {
          uri: url,
          ...clientOptions,
        },
        mode: 'default',
        ...(relations ? { relations } : {}),
      } as DrizzleConfig) as unknown as MySql2Database
      database = db
      return db
    })()

    databasePromise = promise.catch((error) => {
      databasePromise = undefined
      throw error
    })

    return databasePromise
  }

  async function closeDatabase(): Promise<void> {
    if (!database) {
      return
    }

    await closeClient(database)
    database = undefined
    databasePromise = undefined
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
    await runSeeders(db as unknown as Parameters<typeof runSeeders>[0], resolvedSeedersFolder)
  }

  async function withAdminDb<T>(callback: (db: MySql2Database) => Promise<T>): Promise<T> {
    const adminDb = drizzle({
      connection: {
        uri: resolveConnectionString(),
        ...clientOptions,
      },
      mode: 'default',
    } as DrizzleConfig) as unknown as MySql2Database

    try {
      return await callback(adminDb)
    } finally {
      await closeClient(adminDb)
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
      } catch {
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

async function closeClient(db: unknown): Promise<void> {
  if (typeof db !== 'object' || db === null) {
    return
  }

  const maybeClient = (db as { $client?: unknown }).$client as { end?: (...args: unknown[]) => unknown } | undefined
  if (!maybeClient || typeof maybeClient.end !== 'function') {
    return
  }

  if (maybeClient.end.length === 0) {
    const maybePromise = maybeClient.end()
    if (isPromiseLike(maybePromise)) {
      await maybePromise
    }
    return
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    maybeClient.end?.((error?: unknown) => {
      if (error) {
        rejectClose(error)
        return
      }
      resolveClose()
    })
  })
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof (value as { then: unknown }).then === 'function'
}

