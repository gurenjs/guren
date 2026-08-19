import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hotReloadKey, releaseActiveConnection, replaceActiveConnection } from './active-connections'
import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { buildMigrationStatus, migrationFailure, seedFailure, inspectMigrationsFolder, listLocalMigrations, noMigrationsToRun, type MigrationRunSummary, type MigrationStatusEntry } from './migration-utils'
import { runSeeders, type SeederRunSummary } from './seeder'
import { singleFlight } from './single-flight'

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
  /** Applies pending drizzle-kit migrations and reports what the folder held. */
  migrateDatabase(): Promise<MigrationRunSummary>
  closeDatabase(): Promise<void>
  configureOrm(): Promise<void>
  /** Runs every seeder in the configured folder and reports what it held. */
  seedDatabase(): Promise<SeederRunSummary>
  /**
   * Drops every table and view (including the drizzle migration tracker), then
   * re-applies migrations — same end state as `guren db:reset`. Resolves
   * undefined only when a concurrent `closeDatabase()` left nothing to drop, so
   * there was no migration run to report.
   */
  resetDatabase(): Promise<MigrationRunSummary | undefined>
  /** Per-migration applied state derived from the drizzle-kit journal and the __drizzle_migrations table. */
  migrationStatus(): Promise<MigrationStatusEntry[]>
}

function isInMemory(dbPath: string): boolean {
  return dbPath === ':memory:' || dbPath === '' || dbPath.startsWith('file::memory:')
}

/**
 * A scheme *with an authority* — the `//` is what separates a connection URI
 * from a filename — for every scheme that could name a database server.
 *
 * Two exclusions keep legal filenames out of it. `file:` is sqlite's own URI
 * scheme and never addresses a server, so all of its forms stay legal, the
 * authority-shaped `file:///absolute/path.db` included. And the scheme must be
 * at least two characters: no registered scheme is one letter, while `C://db`
 * is a Windows drive path whose separator merely got doubled.
 *
 * Everything without a scheme is untouched — `:memory:`, `file::memory:`,
 * `file:local.db`, and every relative and absolute path.
 */
const CONNECTION_URI = /^(?!file:)[a-z][a-z0-9+.-]+:\/\//i

/**
 * This driver `mkdir -p`s the filename's directory, which is what makes a
 * connection string dangerous rather than merely wrong: `postgres://u:pw@host/db`
 * does not fail, it *succeeds* — creating a `postgres:/u:pw@host/db` tree and
 * migrating into a database nobody ever reads, while `db:migrate` and
 * `db:status` agree with each other on that stray file. Rejecting before the
 * mkdir is the difference between a stop and a silent success.
 *
 * The likeliest source is an ambient `DATABASE_URL` that a sqlite app never
 * meant to consume — the resolved value is checked, not the option, so the
 * env fallback below is covered too.
 */
function assertNotConnectionUri(dbPath: string, source: string): void {
  if (!CONNECTION_URI.test(dbPath)) return

  throw new Error(
    `createSqliteDatabase() received a connection URI where it expects a file path: ${dbPath} (from ${source}). ` +
      'Left alone it would be created as a directory tree and migrated into silently. ' +
      'Pass a path such as "./data/guren.db", or ":memory:".',
  )
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

  let sqliteClient:
    | { query(sql: string): { all(): unknown[] }; exec(sql: string): void; close(): void }
    | undefined
  let activeKey: string | undefined
  // Captured here, not in the connection factory, so the caller of this factory
  // is the frame that identifies the handle across hot reloads.
  const callSite = new Error().stack

  function resolveFilename(): string {
    const value = typeof filename === 'function' ? filename() : filename
    if (value != null) {
      assertNotConnectionUri(value, 'the "filename" option')
      return value
    }

    const fromEnv = process.env.DATABASE_URL
    if (fromEnv != null) {
      assertNotConnectionUri(fromEnv, 'DATABASE_URL')
      return fromEnv
    }

    return './data/guren.db'
  }

  // Unlike the other drivers, this flight must not open with
  // `await migrations.get()`: sqlite migrates over this very handle, so the
  // migration flight awaits `database.get()` and the two would deadlock.
  // `getDatabase()` sequences them from outside instead.
  const database = singleFlight(async (): Promise<unknown> => {
    const dbPath = resolveFilename()

    // Ensure the directory exists
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    try {
      mkdirSync(dirname(resolve(dbPath)), { recursive: true })
    } catch {
      // directory may already exist
    }

    // Both driver modules are resolved before any client exists. An attempt
    // that rejects with the client already open strands it — the memo is
    // dropped, so the retry opens a second one and overwrites `sqliteClient` —
    // and a missing `drizzle-orm/bun-sqlite` is the likeliest way to reject
    // here. Keeping the two loads above `new Database()` also leaves
    // `replaceActiveConnection` as the only await the attempt takes once the
    // client is live.
    const { Database } = await import('bun:sqlite')
    const { drizzle } = await import('drizzle-orm/bun-sqlite')
    type DrizzleConfig = NonNullable<Exclude<Parameters<typeof drizzle>[0], string>>

    const sqlite = new Database(dbPath)
    sqlite.exec('PRAGMA journal_mode = WAL;')
    sqliteClient = sqlite
    // Returned from this local, not from closure state: a newer evaluation may
    // close this handle while the await below is suspended, clearing
    // `sqliteClient` and dropping the memo this attempt is filling. The attempt
    // still owes its own callers the handle it built.
    const handle = drizzle({ client: sqlite, ...(relations ? { relations } : {}) } as DrizzleConfig)

    // In-memory databases share no underlying file, so two of them are distinct
    // handles even when every option matches — there is nothing to key them on.
    activeKey = isInMemory(dbPath) ? undefined : hotReloadKey('sqlite', callSite, resolve(dbPath))
    if (activeKey) {
      await replaceActiveConnection(activeKey, closeDatabase)
    }

    return handle
  })

  async function closeDatabase(): Promise<void> {
    if (!sqliteClient) return

    const key = activeKey
    activeKey = undefined

    try {
      sqliteClient.close()
    } finally {
      sqliteClient = undefined
      database.reset()
      if (key) {
        releaseActiveConnection(key, closeDatabase)
      }
    }
  }

  const migrations = singleFlight(async (): Promise<MigrationRunSummary> => {
    try {
      const summary = inspectMigrationsFolder(resolvedMigrationsFolder)
      if (summary.migrationsFound === 0) {
        return noMigrationsToRun(summary)
      }

      const db = await database.get()
      const { migrate } = await import('drizzle-orm/bun-sqlite/migrator')
      await migrate(db as any, { migrationsFolder: resolvedMigrationsFolder }) // eslint-disable-line @typescript-eslint/no-explicit-any

      return summary
    } catch (error) {
      // No endpoint: a SQLite file has no host, so only the cause chain adds signal.
      throw migrationFailure(error)
    }
  })

  return {
    async getDatabase() {
      await migrations.get()
      return database.get()
    },

    migrateDatabase: migrations.get,

    closeDatabase,

    async resetDatabase(): Promise<MigrationRunSummary | undefined> {
      await database.get()
      // Only reachable when a concurrent evaluation closed the handle while the
      // await above was suspended. Nothing here can act on a closed handle, and
      // migrating would re-open one against a database this call never dropped.
      // No migration ran, so there is nothing to report about one.
      if (!sqliteClient) return undefined

      // Anything left behind fails the next migration run, and three things
      // stand between this loop and that: SQLite refuses DROP TABLE on a view,
      // `_` is a LIKE wildcard so the internal-name filter needs ESCAPE, and an
      // unqualified drop resolves against `temp` before `main`. Each has a
      // regression test alongside. Indexes and triggers stay out of the
      // selection; they go with their table.
      const objects = sqliteClient
        .query(
          "SELECT name, type FROM main.sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
        )
        .all() as Array<{ name: string; type: string }>

      sqliteClient.exec('PRAGMA foreign_keys = OFF;')
      try {
        for (const { name, type } of objects) {
          const quoted = `main."${name.replaceAll('"', '""')}"`
          sqliteClient.exec(type === 'view' ? `DROP VIEW IF EXISTS ${quoted}` : `DROP TABLE IF EXISTS ${quoted}`)
        }
      } finally {
        sqliteClient.exec('PRAGMA foreign_keys = ON;')
      }

      // Drop the memo so the run below re-applies everything from scratch, then
      // migrate: a reset ends on a migrated database, the same state `guren
      // db:reset` leaves behind. A caller that migrates again — the documented
      // reset-then-migrate pattern — hits the memo and no-ops.
      migrations.reset()
      return migrations.get()
    },

    async migrationStatus() {
      const localMigrations = listLocalMigrations(resolvedMigrationsFolder)
      if (localMigrations.length === 0) return []

      await database.get()
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
      const db = await database.get()
      await migrations.get()
      DrizzleAdapter.configure(db as Parameters<typeof DrizzleAdapter.configure>[0])
    },

    async seedDatabase(): Promise<SeederRunSummary> {
      if (!resolvedSeedersFolder) {
        throw new Error('No seeders folder configured. Provide "seedersFolder" when calling createSqliteDatabase().')
      }
      const db = await database.get()
      try {
        // No endpoint: a SQLite file has no host, so only the cause chain adds signal.
        // Awaited inside the try so a seeder that throws still reaches seedFailure().
        return await runSeeders(db, resolvedSeedersFolder)
      } catch (error) {
        throw seedFailure(error)
      }
    },
  }
}

