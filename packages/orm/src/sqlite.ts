import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { buildMigrationStatus, hasDrizzleMigrations, listLocalMigrations, warnIgnoredFlatSqlMigrations, type MigrationStatusEntry } from './migration-utils'
import { runSeeders } from './seeder'

type ConnectionResolver = string | (() => string | undefined)

export interface SqliteDatabaseOptions {
  migrationsFolder: string | URL
  /** Path to the SQLite database file. Defaults to `./data/guren.db`. */
  filename?: ConnectionResolver
  seedersFolder?: string | URL
  /**
   * Drizzle relations for RQB v2 (`db.query.*`).
   * Build with `defineRelations(schema, ...)` from `drizzle-orm`,
   * or with `relations()` from `drizzle-orm/_relations` for the RQB v1 partial-upgrade path.
   */
  relations?: Record<string, unknown>
}

export interface SqliteDatabase {
  getDatabase(): Promise<unknown>
  migrateDatabase(): Promise<void>
  closeDatabase(): Promise<void>
  configureOrm(): Promise<void>
  seedDatabase(): Promise<void>
  /** Drops every table (including the drizzle migration tracker) so migrations can be re-applied from scratch. */
  resetDatabase(): Promise<void>
  /** Per-migration applied state derived from the drizzle-kit journal and the __drizzle_migrations table. */
  migrationStatus(): Promise<MigrationStatusEntry[]>
}

export function createSqliteDatabase(options: SqliteDatabaseOptions): SqliteDatabase {
  const { migrationsFolder, filename, seedersFolder, relations } = options

  const resolvedMigrationsFolder =
    migrationsFolder instanceof URL ? fileURLToPath(migrationsFolder) : resolve(String(migrationsFolder))
  const resolvedSeedersFolder =
    seedersFolder == null
      ? undefined
      : seedersFolder instanceof URL
        ? fileURLToPath(seedersFolder)
        : resolve(String(seedersFolder))

  let db: unknown
  let sqliteClient: { query(sql: string): { all(): unknown[] }; exec(sql: string): void } | undefined
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
    sqliteClient = sqlite

    const { drizzle } = await import('drizzle-orm/bun-sqlite')
    type DrizzleConfig = NonNullable<Exclude<Parameters<typeof drizzle>[0], string>>
    db = drizzle({ client: sqlite, ...(relations ? { relations } : {}) } as DrizzleConfig)
    return db
  }

  async function migrateOnce(): Promise<void> {
    if (migrationsPromise) return migrationsPromise

    migrationsPromise = (async () => {
      if (!hasDrizzleMigrations(resolvedMigrationsFolder)) {
        warnIgnoredFlatSqlMigrations(resolvedMigrationsFolder)
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
      sqliteClient = undefined
    },

    async resetDatabase() {
      await ensureDatabase()
      if (!sqliteClient) return

      const tables = sqliteClient
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>

      sqliteClient.exec('PRAGMA foreign_keys = OFF;')
      try {
        for (const { name } of tables) {
          sqliteClient.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`)
        }
      } finally {
        sqliteClient.exec('PRAGMA foreign_keys = ON;')
      }

      // Allow migrateDatabase() to re-apply everything from scratch.
      migrationsPromise = undefined
    },

    async migrationStatus() {
      const localMigrations = listLocalMigrations(resolvedMigrationsFolder)
      if (localMigrations.length === 0) return []

      await ensureDatabase()
      let appliedRows: Array<{ name: string | null; appliedAt: string | null }> = []
      try {
        const rows = sqliteClient
          ?.query('SELECT name, applied_at FROM __drizzle_migrations')
          .all() as Array<{ name: string | null; applied_at: string | null }> | undefined
        appliedRows = (rows ?? []).map((row) => ({ name: row.name, appliedAt: row.applied_at }))
      } catch {
        // Tracker table does not exist yet — nothing applied.
      }

      return buildMigrationStatus(localMigrations, appliedRows)
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

