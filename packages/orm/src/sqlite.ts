import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { runSeeders } from './seeder'

type ConnectionResolver = string | (() => string | undefined)

export interface SqliteDatabaseOptions<TSchema extends Record<string, unknown>> {
  schema: TSchema
  migrationsFolder: string | URL
  /** Path to the SQLite database file. Defaults to `./data/guren.db`. */
  filename?: ConnectionResolver
  seedersFolder?: string | URL
}

export interface SqliteDatabase<TSchema extends Record<string, unknown>> {
  getDatabase(): Promise<unknown>
  migrateDatabase(): Promise<void>
  closeDatabase(): Promise<void>
  configureOrm(): Promise<void>
  seedDatabase(): Promise<void>
}

export function createSqliteDatabase<TSchema extends Record<string, unknown>>(
  options: SqliteDatabaseOptions<TSchema>,
): SqliteDatabase<TSchema> {
  const { schema, migrationsFolder, filename, seedersFolder } = options

  const resolvedMigrationsFolder =
    migrationsFolder instanceof URL ? fileURLToPath(migrationsFolder) : resolve(String(migrationsFolder))
  const resolvedSeedersFolder =
    seedersFolder == null
      ? undefined
      : seedersFolder instanceof URL
        ? fileURLToPath(seedersFolder)
        : resolve(String(seedersFolder))

  let db: unknown
  let migrationsPromise: Promise<void> | undefined

  function resolveFilename(): string {
    const value = typeof filename === 'function' ? filename() : filename
    return value ?? process.env.DATABASE_URL ?? './data/guren.db'
  }

  async function ensureDatabase(): Promise<unknown> {
    if (db) return db

    const dbPath = resolveFilename()

    // Ensure the directory exists
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    try {
      mkdirSync(dirname(resolve(dbPath)), { recursive: true })
    } catch {
      // directory may already exist
    }

    const { Database } = await import('bun:sqlite')
    const sqlite = new Database(dbPath)
    sqlite.exec('PRAGMA journal_mode = WAL;')

    const { drizzle } = await import('drizzle-orm/bun-sqlite')
    db = drizzle({ client: sqlite, schema })
    return db
  }

  async function migrateOnce(): Promise<void> {
    if (migrationsPromise) return migrationsPromise

    migrationsPromise = (async () => {
      if (!hasDrizzleMigrations(resolvedMigrationsFolder)) {
        return
      }

      const database = await ensureDatabase()
      const { migrate } = await import('drizzle-orm/bun-sqlite/migrator')
      await migrate(database as any, { migrationsFolder: resolvedMigrationsFolder }) // eslint-disable-line @typescript-eslint/no-explicit-any
    })()

    migrationsPromise = migrationsPromise.catch((error) => {
      migrationsPromise = undefined
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to run database migrations: ${reason}`)
    })

    await migrationsPromise
  }

  return {
    async getDatabase() {
      await migrateOnce()
      return ensureDatabase()
    },

    migrateDatabase: migrateOnce,

    async closeDatabase() {
      if (!db) return
      // bun:sqlite Database doesn't need explicit close for WAL mode
      db = undefined
    },

    async configureOrm() {
      const database = await ensureDatabase()
      await migrateOnce()
      DrizzleAdapter.configure(database as Parameters<typeof DrizzleAdapter.configure>[0])
    },

    async seedDatabase() {
      if (!resolvedSeedersFolder) {
        throw new Error('No seeders folder configured. Provide "seedersFolder" when calling createSqliteDatabase().')
      }
      const database = await ensureDatabase()
      await runSeeders(
        database as Parameters<typeof runSeeders>[0],
        resolvedSeedersFolder,
      )
    },
  }
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
