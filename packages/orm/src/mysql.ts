import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { runSeeders } from './seeder'

type ConnectionResolver = string | (() => string | undefined)
type MySqlConnectionOptions = Record<string, unknown>

export interface MySqlDatabaseOptions<TSchema extends Record<string, unknown>> {
  schema: TSchema
  migrationsFolder: string | URL
  connectionString?: ConnectionResolver
  clientOptions?: MySqlConnectionOptions
  seedersFolder?: string | URL
}

export interface MySqlDatabase<TSchema extends Record<string, unknown>> {
  getDatabase(): Promise<MySql2Database<TSchema>>
  migrateDatabase(): Promise<void>
  closeDatabase(): Promise<void>
  configureOrm(): Promise<void>
  seedDatabase(): Promise<void>
}

export function createMySqlDatabase<TSchema extends Record<string, unknown>>(options: MySqlDatabaseOptions<TSchema>): MySqlDatabase<TSchema> {
  const { schema, migrationsFolder, connectionString, clientOptions, seedersFolder } = options

  const resolvedMigrationsFolder =
    migrationsFolder instanceof URL ? fileURLToPath(migrationsFolder) : resolve(String(migrationsFolder))
  const resolvedSeedersFolder =
    seedersFolder == null ? undefined : seedersFolder instanceof URL ? fileURLToPath(seedersFolder) : resolve(String(seedersFolder))

  let migrationsPromise: Promise<void> | undefined
  let databasePromise: Promise<MySql2Database<TSchema>> | undefined
  let database: MySql2Database<TSchema> | undefined

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
        return
      }

      const url = resolveConnectionString()
      const migrationDb = drizzle({
        connection: {
          uri: url,
          ...clientOptions,
        },
        schema,
        mode: 'default',
      })

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

  async function getDatabase(): Promise<MySql2Database<TSchema>> {
    if (databasePromise) {
      return databasePromise
    }

    const promise = (async () => {
      await migrateOnce()
      const url = resolveConnectionString()
      const db = drizzle({
        connection: {
          uri: url,
          ...clientOptions,
        },
        schema,
        mode: 'default',
      })
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

  return {
    getDatabase,
    migrateDatabase: migrateOnce,
    closeDatabase,
    configureOrm,
    seedDatabase,
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

function hasDrizzleMigrations(migrationsFolder: string): boolean {
  if (!existsSync(migrationsFolder)) {
    return false
  }

  // v1: folder-based migrations (YYYYMMDD_name/migration.sql)
  const entries = readdirSync(migrationsFolder, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && existsSync(resolve(migrationsFolder, entry.name, 'migration.sql'))) {
      return true
    }
  }

  // v0: journal-based migrations (meta/_journal.json)
  return existsSync(resolve(migrationsFolder, 'meta/_journal.json'))
}
