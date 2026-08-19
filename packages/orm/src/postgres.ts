import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type postgres from 'postgres'
import { hotReloadKey, releaseActiveConnection, replaceActiveConnection } from './active-connections'
import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { buildMigrationStatus, describeConnectionEndpoint, describeDatabaseFailure, isConnectionFailure, migrationFailure, seedFailure, inspectMigrationsFolder, listLocalMigrations, noMigrationsToRun, type MigrationRunSummary, type MigrationStatusEntry } from './migration-utils'
import { runSeeders } from './seeder'
import { singleFlight } from './single-flight'

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
  /** Applies pending drizzle-kit migrations and reports what the folder held. */
  migrateDatabase(): Promise<MigrationRunSummary>
  closeDatabase(): Promise<void>
  configureOrm(): Promise<void>
  seedDatabase(): Promise<void>
  /** Drops the public schema (and the drizzle tracker schema), then re-applies migrations — same end state as `guren db:reset`. */
  resetDatabase(): Promise<MigrationRunSummary>
  /** Per-migration applied state derived from the drizzle-kit journal and drizzle.__drizzle_migrations. */
  migrationStatus(): Promise<MigrationStatusEntry[]>
}

export function createPostgresDatabase(options: PostgresDatabaseOptions): PostgresDatabase {
  const { migrationsFolder, connectionString, clientOptions, seedersFolder, relations } = options

  const resolvedMigrationsFolder =
    migrationsFolder instanceof URL ? fileURLToPath(migrationsFolder) : resolve(String(migrationsFolder))
  const resolvedSeedersFolder =
    seedersFolder == null ? undefined : seedersFolder instanceof URL ? fileURLToPath(seedersFolder) : resolve(String(seedersFolder))

  let client: ReturnType<typeof postgres> | undefined
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
      const summary = inspectMigrationsFolder(resolvedMigrationsFolder)
      if (summary.migrationsFound === 0) {
        return noMigrationsToRun(summary)
      }

      const { drizzle, migrate, postgres: postgresFactory } = await loadPostgresModules()
      const url = resolveConnectionString()
      endpoint = describeConnectionEndpoint(url)
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

      return summary
    } catch (error) {
      throw migrationFailure(error, endpoint)
    }
  })

  const database = singleFlight(async (): Promise<PostgresJsDatabase> => {
    await migrations.get()
    const { drizzle, postgres: postgresFactory } = await loadPostgresModules()
    const url = resolveConnectionString()
    // Held locally as well as in closure state: a newer evaluation may close
    // this client while the await below is suspended, which clears `client`.
    const activeClient = postgresFactory(url, {
      max: 1,
      ...clientOptions,
    })
    client = activeClient

    activeKey = hotReloadKey('postgres', callSite, url)
    if (activeKey) {
      await replaceActiveConnection(activeKey, closeDatabase)
    }

    return drizzle({
      client: activeClient,
      ...(relations ? { relations } : {}),
    } as DrizzleConfig) as unknown as PostgresJsDatabase
  })

  async function closeDatabase(): Promise<void> {
    if (!client) {
      return
    }

    const key = activeKey
    activeKey = undefined

    try {
      await client.end({ timeout: 0 })
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
      throw new Error('No seeders folder configured. Provide "seedersFolder" when calling createPostgresDatabase().')
    }

    const db = await database.get()
    try {
      await runSeeders(db, resolvedSeedersFolder)
    } catch (error) {
      throw seedFailure(error, describeConnectionEndpoint(resolveConnectionString()))
    }
  }

  async function withAdminClient<T>(callback: (client: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
    const { postgres: postgresFactory } = await loadPostgresModules()
    const url = resolveConnectionString()
    const adminClient = postgresFactory(url, {
      max: 1,
      ...clientOptions,
    })
    try {
      return await callback(adminClient)
    } catch (error) {
      // postgres-js reports an unreachable server as an AggregateError whose
      // message is empty, so rethrowing raw prints a bare "ERROR" line.
      throw new Error(describeDatabaseFailure(error, describeConnectionEndpoint(url)))
    } finally {
      await adminClient.end({ timeout: 0 })
    }
  }

  async function resetDatabase(): Promise<MigrationRunSummary> {
    await withAdminClient(async (adminClient) => {
      await adminClient.unsafe('DROP SCHEMA IF EXISTS public CASCADE')
      await adminClient.unsafe('CREATE SCHEMA public')
      await adminClient.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE')
    })

    // Drop the memo so the run below re-applies everything from scratch, then
    // migrate: a reset ends on a migrated database, the same state `guren
    // db:reset` leaves behind. A caller that migrates again — the documented
    // reset-then-migrate pattern — hits the memo and no-ops.
    migrations.reset()
    return migrations.get()
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

