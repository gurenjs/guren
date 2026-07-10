import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { hasDrizzleMigrations, warnIgnoredFlatSqlMigrations } from './migration-utils'
import { runSeeders } from './seeder'

type ConnectionResolver = string | (() => string | undefined)
type DrizzleConfig = Exclude<Parameters<typeof drizzle>[0], string>

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

      const url = resolveConnectionString()
      const migrationClient = postgres(url, {
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
      const url = resolveConnectionString()
      client = postgres(url, {
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

  return {
    getDatabase,
    migrateDatabase: migrateOnce,
    closeDatabase,
    configureOrm,
    seedDatabase,
  }
}

