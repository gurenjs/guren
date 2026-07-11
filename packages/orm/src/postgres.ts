import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type postgres from 'postgres'
import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { buildMigrationStatus, hasDrizzleMigrations, listLocalMigrations, warnIgnoredFlatSqlMigrations, type MigrationStatusEntry } from './migration-utils'
import { runSeeders } from './seeder'

type ConnectionResolver = string | (() => string | undefined)
type PostgresJsDrizzle = typeof import('drizzle-orm/postgres-js')
type DrizzleConfig = Exclude<Parameters<PostgresJsDrizzle['drizzle']>[0], string>

// The postgres driver packages are loaded lazily so importing @guren/orm
// does not require `postgres` to be installed (e.g. SQLite-only apps).
async function loadPostgresModules(): Promise<{
  drizzle: PostgresJsDrizzle['drizzle']
  migrate: typeof import('drizzle-orm/postgres-js/migrator')['migrate']
  postgres: typeof postgres
}> {
  try {
    const [{ drizzle }, { migrate }, postgresModule] = await Promise.all([
      import('drizzle-orm/postgres-js'),
      import('drizzle-orm/postgres-js/migrator'),
      import('postgres'),
    ])
    return { drizzle, migrate, postgres: postgresModule.default }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `createPostgresDatabase() requires the "postgres" package. Install it with \`bun add postgres\`. (${reason})`,
    )
  }
}

export interface PostgresDatabaseOptions {
  migrationsFolder: string | URL
  connectionString?: ConnectionResolver
  clientOptions?: postgres.Options<Record<string, never>>
  seedersFolder?: string | URL
  /**
   * Drizzle relations for RQB v2 (`db.query.*`).
   * Build with `defineRelations(schema, ...)` from `drizzle-orm`,
   * or with `relations()` from `drizzle-orm/_relations` for the RQB v1 partial-upgrade path.
   */
  relations?: Record<string, unknown>
}

export interface PostgresDatabase {
  getDatabase(): Promise<PostgresJsDatabase>
  migrateDatabase(): Promise<void>
  closeDatabase(): Promise<void>
  configureOrm(): Promise<void>
  seedDatabase(): Promise<void>
  /** Drops the public schema (and the drizzle tracker schema) so migrations can be re-applied from scratch. */
  resetDatabase(): Promise<void>
  /** Per-migration applied state derived from the drizzle-kit journal and drizzle.__drizzle_migrations. */
  migrationStatus(): Promise<MigrationStatusEntry[]>
}

export function createPostgresDatabase(options: PostgresDatabaseOptions): PostgresDatabase {
  const { migrationsFolder, connectionString, clientOptions, seedersFolder, relations } = options

  const resolvedMigrationsFolder =
    migrationsFolder instanceof URL ? fileURLToPath(migrationsFolder) : resolve(String(migrationsFolder))
  const resolvedSeedersFolder =
    seedersFolder == null ? undefined : seedersFolder instanceof URL ? fileURLToPath(seedersFolder) : resolve(String(seedersFolder))

  let migrationsPromise: Promise<void> | undefined
  let databasePromise: Promise<PostgresJsDatabase> | undefined
  let client: ReturnType<typeof postgres> | undefined

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

      const { drizzle, migrate, postgres: postgresFactory } = await loadPostgresModules()
      const url = resolveConnectionString()
      const migrationClient = postgresFactory(url, {
        max: 1,
        ...clientOptions,
      })

      try {
        const db = drizzle({ client: migrationClient, ...(relations ? { relations } : {}) } as DrizzleConfig)
        await migrate(db, { migrationsFolder: resolvedMigrationsFolder })
      } finally {
        await migrationClient.end({ timeout: 0 })
      }
    })()

    migrationsPromise = promise.catch((error) => {
      migrationsPromise = undefined
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to run database migrations: ${reason}`)
    })

    await migrationsPromise
  }

  async function getDatabase(): Promise<PostgresJsDatabase> {
    if (databasePromise) {
      return databasePromise
    }

    const promise = (async (): Promise<PostgresJsDatabase> => {
      await migrateOnce()
      const { drizzle, postgres: postgresFactory } = await loadPostgresModules()
      const url = resolveConnectionString()
      client = postgresFactory(url, {
        max: 1,
        ...clientOptions,
      })

      return drizzle({ client, ...(relations ? { relations } : {}) } as DrizzleConfig) as unknown as PostgresJsDatabase
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

    await client.end({ timeout: 0 })
    client = undefined
    databasePromise = undefined
  }

  async function configureOrm(): Promise<void> {
    const db = await getDatabase()
    DrizzleAdapter.configure(db as unknown as Parameters<typeof DrizzleAdapter.configure>[0])
  }

  async function seedDatabase(): Promise<void> {
    if (!resolvedSeedersFolder) {
      throw new Error('No seeders folder configured. Provide "seedersFolder" when calling createPostgresDatabase().')
    }

    const db = await getDatabase()
    await runSeeders(db, resolvedSeedersFolder)
  }

  async function withAdminClient<T>(callback: (client: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
    const { postgres: postgresFactory } = await loadPostgresModules()
    const adminClient = postgresFactory(resolveConnectionString(), {
      max: 1,
      ...clientOptions,
    })
    try {
      return await callback(adminClient)
    } finally {
      await adminClient.end({ timeout: 0 })
    }
  }

  async function resetDatabase(): Promise<void> {
    await withAdminClient(async (adminClient) => {
      await adminClient.unsafe('DROP SCHEMA IF EXISTS public CASCADE')
      await adminClient.unsafe('CREATE SCHEMA public')
      await adminClient.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE')
    })

    // Allow migrateDatabase() to re-apply everything from scratch.
    migrationsPromise = undefined
  }

  async function migrationStatus(): Promise<MigrationStatusEntry[]> {
    const localMigrations = listLocalMigrations(resolvedMigrationsFolder)
    if (localMigrations.length === 0) return []

    const appliedRows = await withAdminClient(async (adminClient) => {
      try {
        const rows = await adminClient.unsafe('SELECT name FROM drizzle.__drizzle_migrations')
        return rows.map((row) => {
          const record = row as unknown as { name: string | null }
          return { name: record.name, appliedAt: null }
        })
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

