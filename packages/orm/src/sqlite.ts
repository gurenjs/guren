import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hotReloadKey, releaseActiveConnection, replaceActiveConnection } from './active-connections'
import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { buildMigrationStatus, isMissingTrackerTable, migrationFailure, seedFailure, inspectMigrationsFolder, listLocalMigrations, noMigrationsToRun, type MigrationRunSummary, type MigrationStatusEntry } from './migration-utils'
import { runSeeders, type SeederRunSummary } from './seeder'
import { singleFlight } from './single-flight'

type ConnectionResolver = string | (() => string | undefined)

export interface SqliteDatabaseOptions {
  migrationsFolder: string | URL
  /** Path to the SQLite database file. Defaults to `./data/guren.db`. */
  filename?: ConnectionResolver
  seedersFolder?: string | URL
  /**
   * Drizzle relations for RQB v2 (`db.query.*`): `defineRelations(schema, ...)`
   * from `drizzle-orm`, or `relations()` from `drizzle-orm/_relations` for the
   * RQB v1 partial-upgrade path.
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
   * re-applies migrations — same end state as `guren db:reset`. Undefined only
   * when a concurrent `closeDatabase()` left nothing to drop.
   */
  resetDatabase(): Promise<MigrationRunSummary | undefined>
  /** Per-migration applied state derived from the drizzle-kit journal and the __drizzle_migrations table. */
  migrationStatus(): Promise<MigrationStatusEntry[]>
}

function isInMemory(dbPath: string): boolean {
  return dbPath === ':memory:' || dbPath === '' || dbPath.startsWith('file::memory:')
}

/**
 * Path to open for `dbPath`; undefined for in-memory forms and unresolvable
 * URIs, which `new Database()` refuses with no directory created. `file:` URI
 * support is compile-time `SQLITE_USE_URI` (measured: on for Bun/macOS via system
 * libsqlite3, off in Bun's Linux build, which opens `file:local.db` literally), so
 * parsing follows https://sqlite.org/uri.html, not WHATWG (`/local.db` vs the cwd).
 */
function sqliteFilePath(dbPath: string): string | undefined {
  if (isInMemory(dbPath)) return undefined
  // Scheme comparison is case-sensitive here because it is in sqlite: `FILE:x`
  // opens a file whose name literally starts with `FILE:`.
  if (!dbPath.startsWith('file:')) return resolve(dbPath)

  let rest = dbPath.slice('file:'.length)
  if (rest.startsWith('//')) {
    const pathStart = rest.indexOf('/', 2)
    const authority = pathStart === -1 ? rest.slice(2) : rest.slice(2, pathStart)
    if (authority !== '' && authority !== 'localhost') return undefined
    rest = pathStart === -1 ? '' : rest.slice(pathStart)
  }

  // Split before decoding: a percent-encoded `?` belongs to the filename, and
  // decoding first would hand the query it introduces to the filesystem.
  const marker = rest.search(/[?#]/)
  const encodedPath = marker === -1 ? rest : rest.slice(0, marker)
  // A fragment is dropped the way sqlite drops it. A query is not: it changes
  // how the database opens and a plain path cannot carry it — `mode=ro`
  // silently becoming writable has to stop rather than degrade.
  const query = marker !== -1 && rest[marker] === '?' ? rest.slice(marker + 1).split('#')[0] : ''
  if (query !== '') {
    throw new Error(
      `createSqliteDatabase() cannot honour the URI parameters in ${dbPath} (?${query}). ` +
        'They are only read by a sqlite built with SQLITE_USE_URI, which Bun provides on some ' +
        'platforms and not others, so this driver resolves the URI to a path itself. ' +
        'Pass a plain path, and set the behaviour those parameters asked for in code.',
    )
  }
  if (encodedPath === '') return undefined

  try {
    return resolve(decodeURIComponent(encodedPath))
  } catch {
    // Malformed escape — sqlite reports it far better than a mkdir would.
    return undefined
  }
}

/**
 * A scheme *with an authority* — the `//` is what separates a connection URI
 * from a filename. Two exclusions keep legal filenames out: `file:` never
 * addresses a server, so every form of it stays legal; and a one-letter scheme
 * is `C://db`, a Windows drive path with a doubled separator.
 */
const CONNECTION_URI = /^(?!file:)[a-z][a-z0-9+.-]+:\/\//i

/**
 * This driver `mkdir -p`s the filename's directory, so `postgres://u:pw@host/db`
 * does not fail but *succeeds*: it creates a `postgres:/u:pw@host/db` tree and
 * migrates into a database nobody reads. Rejecting before the mkdir is the
 * difference between a stop and a silent success. The resolved value is
 * checked, not the option, so an ambient `DATABASE_URL` is covered too.
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

    // Resolved once: the mkdir, the open and the hot-reload key all have to
    // name the same file, and `dbPath` may be a `file:` URI that is none of them.
    const dbFile = sqliteFilePath(dbPath)

    if (dbFile) {
      const { mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      try {
        mkdirSync(dirname(dbFile), { recursive: true })
      } catch {
        // directory may already exist
      }
    }

    // Both loads stay above `new Database()`: an attempt that rejects with the
    // client already open strands it, since the memo is dropped and the retry
    // opens a second one over `sqliteClient`. That leaves
    // `replaceActiveConnection` as the only await taken with a live client.
    const { Database } = await import('bun:sqlite')
    const { drizzle } = await import('drizzle-orm/bun-sqlite')
    type DrizzleConfig = NonNullable<Exclude<Parameters<typeof drizzle>[0], string>>

    // The resolved path, which is what the mkdir prepared. `dbPath` survives
    // only where there is nothing to resolve — the in-memory forms, and a URI
    // left for `new Database()` to refuse.
    const sqlite = new Database(dbFile ?? dbPath)
    sqlite.exec('PRAGMA journal_mode = WAL;')
    sqliteClient = sqlite
    // Returned from this local: a newer evaluation may close this handle while
    // the await below is suspended, clearing `sqliteClient`, and the attempt
    // still owes its own callers the handle it built.
    const handle = drizzle({ client: sqlite, ...(relations ? { relations } : {}) } as DrizzleConfig)

    // In-memory databases share no file, so there is nothing to key them on.
    // Keying on the resolved file makes `file:///data/app.db` and
    // `/data/app.db` one database across a reload.
    activeKey = dbFile === undefined ? undefined : hotReloadKey('sqlite', callSite, dbFile)
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
      // Only reachable when a concurrent evaluation closed the handle mid-await.
      // Migrating would re-open one against a database this call never dropped.
      if (!sqliteClient) return undefined

      // Anything left behind fails the next migration run, and three things
      // stand in the way: SQLite refuses DROP TABLE on a view, `_` is a LIKE
      // wildcard so the internal-name filter needs ESCAPE, and an unqualified
      // drop resolves against `temp` before `main`. Indexes and triggers go
      // with their table.
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

      // A reset ends on a migrated database, like `guren db:reset`. Dropping
      // the memo re-applies from scratch; a caller that then migrates again
      // hits the fresh memo and no-ops.
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
      } catch (error) {
        // Only a missing tracker means "nothing applied". A drifted tracker
        // column must not read as all-pending.
        if (!isMissingTrackerTable(error, 'sqlite')) throw error
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

