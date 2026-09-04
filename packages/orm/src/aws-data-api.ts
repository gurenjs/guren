import type { RDSDataClientConfig } from '@aws-sdk/client-rds-data'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hotReloadKey, releaseActiveConnection, replaceActiveConnection } from './active-connections'
import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { buildMigrationStatus, inspectMigrationsFolder, listLocalMigrations, noMigrationsToRun, type MigrationRunSummary, type MigrationStatusEntry } from './migration-utils'
import { runSeeders, type SeederRunSummary } from './seeder'
import { singleFlight } from './single-flight'

type ConnectionResolver = string | (() => string | undefined)
type AwsDataApiDrizzle = typeof import('drizzle-orm/aws-data-api/pg')
type AwsDataApiPgDatabase = import('drizzle-orm/aws-data-api/pg').AwsDataApiPgDatabase
type DrizzleConfig = Parameters<AwsDataApiDrizzle['drizzle']>[0]

// Lazy so importing @guren/orm does not require `@aws-sdk/client-rds-data`.
// The drizzle driver imports the SDK at module scope, so a missing SDK
// surfaces here as an import failure of the driver module.
async function loadAwsDataApiModules(): Promise<{
  drizzle: AwsDataApiDrizzle['drizzle']
  migrate: typeof import('drizzle-orm/aws-data-api/pg/migrator')['migrate']
}> {
  try {
    const [{ drizzle }, { migrate }] = await Promise.all([
      import('drizzle-orm/aws-data-api/pg'),
      import('drizzle-orm/aws-data-api/pg/migrator'),
    ])
    return { drizzle, migrate }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `createAwsDataApiDatabase() requires the "@aws-sdk/client-rds-data" package. Install it with \`bun add @aws-sdk/client-rds-data\`. (${reason})`,
    )
  }
}

export interface AwsDataApiDatabaseOptions {
  migrationsFolder: string | URL
  /** Database name. Falls back to the DATABASE_NAME environment variable. */
  database?: ConnectionResolver
  /** Aurora cluster ARN. Falls back to the DATABASE_RESOURCE_ARN environment variable. */
  resourceArn?: ConnectionResolver
  /** Secrets Manager secret ARN holding the credentials. Falls back to the DATABASE_SECRET_ARN environment variable. */
  secretArn?: ConnectionResolver
  /** Extra RDSDataClient configuration (region, credentials, ...). */
  clientOptions?: RDSDataClientConfig
  /**
   * Run pending migrations on the first `getDatabase()` call. Off by default:
   * on Lambda it costs several serialized Data API round trips on every cold
   * start. Migrate out of band instead — `db:migrate`, or the console handler
   * (`{"command": "db:migrate"}`) once deployed.
   */
  migrateOnStart?: boolean
  seedersFolder?: string | URL
  /**
   * Drizzle relations for RQB v2 (`db.query.*`): `defineRelations(schema, ...)`
   * from `drizzle-orm`, or `relations()` from `drizzle-orm/_relations` for the
   * RQB v1 partial-upgrade path.
   */
  relations?: Record<string, unknown>
}

export interface AwsDataApiDatabase {
  getDatabase(): Promise<AwsDataApiPgDatabase>
  /** Applies pending drizzle-kit migrations and reports what the folder held. */
  migrateDatabase(): Promise<MigrationRunSummary>
  closeDatabase(): Promise<void>
  configureOrm(): Promise<void>
  /** Runs every seeder in the configured folder and reports what it held. */
  seedDatabase(): Promise<SeederRunSummary>
  /** Drops the public schema (and the drizzle tracker schema), then re-applies migrations — same end state as `guren db:reset`. */
  resetDatabase(): Promise<MigrationRunSummary>
  /** Per-migration applied state derived from the drizzle-kit journal and drizzle.__drizzle_migrations. */
  migrationStatus(): Promise<MigrationStatusEntry[]>
}

interface ResolvedConnection {
  database: string
  resourceArn: string
  secretArn: string
}

export function createAwsDataApiDatabase(options: AwsDataApiDatabaseOptions): AwsDataApiDatabase {
  const { migrationsFolder, database, resourceArn, secretArn, clientOptions, migrateOnStart, seedersFolder, relations } = options

  const resolvedMigrationsFolder =
    migrationsFolder instanceof URL ? fileURLToPath(migrationsFolder) : resolve(String(migrationsFolder))
  const resolvedSeedersFolder =
    seedersFolder == null ? undefined : seedersFolder instanceof URL ? fileURLToPath(seedersFolder) : resolve(String(seedersFolder))

  let client: { destroy?: () => void } | undefined
  let activeKey: string | undefined
  // Captured here, not in the connection factory, so the caller of this factory
  // is the frame that identifies the handle across hot reloads.
  const callSite = new Error().stack

  function resolveConnection(): ResolvedConnection {
    const resolveValue = (value: ConnectionResolver | undefined, envKey: string): string | undefined => {
      const resolved = typeof value === 'function' ? value() : value
      return resolved ?? process.env[envKey]
    }

    const resolvedDatabase = resolveValue(database, 'DATABASE_NAME')
    const resolvedResourceArn = resolveValue(resourceArn, 'DATABASE_RESOURCE_ARN')
    const resolvedSecretArn = resolveValue(secretArn, 'DATABASE_SECRET_ARN')

    const missing = [
      resolvedDatabase ? null : 'database (DATABASE_NAME)',
      resolvedResourceArn ? null : 'resourceArn (DATABASE_RESOURCE_ARN)',
      resolvedSecretArn ? null : 'secretArn (DATABASE_SECRET_ARN)',
    ].filter((entry): entry is string => entry !== null)

    if (missing.length > 0) {
      throw new Error(`Missing AWS Data API connection settings: ${missing.join(', ')}.`)
    }

    return { database: resolvedDatabase!, resourceArn: resolvedResourceArn!, secretArn: resolvedSecretArn! }
  }

  function buildDrizzleConfig(connection: ResolvedConnection): DrizzleConfig {
    return {
      connection: {
        ...clientOptions,
        ...connection,
      },
      ...(relations ? { relations } : {}),
    } as DrizzleConfig
  }

  const migrations = singleFlight(async (): Promise<MigrationRunSummary> => {
    try {
      const summary = inspectMigrationsFolder(resolvedMigrationsFolder)
      if (summary.migrationsFound === 0) {
        return noMigrationsToRun(summary)
      }

      const { migrate } = await loadAwsDataApiModules()
      await withAdminDb((db) => migrate(db, { migrationsFolder: resolvedMigrationsFolder }))

      return summary
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to run database migrations: ${reason}`)
    }
  })

  const databaseHandle = singleFlight(async (): Promise<AwsDataApiPgDatabase> => {
    if (migrateOnStart) {
      await migrations.get()
    }
    const { drizzle } = await loadAwsDataApiModules()
    const connection = resolveConnection()
    const db = drizzle(buildDrizzleConfig(connection)) as unknown as AwsDataApiPgDatabase
    client = (db as { $client?: { destroy?: () => void } }).$client

    activeKey = hotReloadKey('aws-data-api', callSite, `${connection.resourceArn}/${connection.database}`)
    if (activeKey) {
      await replaceActiveConnection(activeKey, closeDatabase)
    }

    return db
  })

  async function closeDatabase(): Promise<void> {
    if (!client) {
      return
    }

    const key = activeKey
    activeKey = undefined

    try {
      client.destroy?.()
    } finally {
      client = undefined
      databaseHandle.reset()
      if (key) {
        releaseActiveConnection(key, closeDatabase)
      }
    }
  }

  async function configureOrm(): Promise<void> {
    const db = await databaseHandle.get()
    DrizzleAdapter.configure(db as unknown as Parameters<typeof DrizzleAdapter.configure>[0])
  }

  async function seedDatabase(): Promise<SeederRunSummary> {
    if (!resolvedSeedersFolder) {
      throw new Error('No seeders folder configured. Provide "seedersFolder" when calling createAwsDataApiDatabase().')
    }

    const db = await databaseHandle.get()
    return runSeeders(db, resolvedSeedersFolder)
  }

  async function withAdminDb<T>(callback: (db: AwsDataApiPgDatabase) => Promise<T>): Promise<T> {
    const { drizzle } = await loadAwsDataApiModules()
    const adminDb = drizzle(buildDrizzleConfig(resolveConnection())) as unknown as AwsDataApiPgDatabase & {
      $client?: { destroy?: () => void }
    }

    try {
      return await callback(adminDb)
    } finally {
      // Stateless HTTP client: destroy() only releases the SDK's socket pool.
      adminDb.$client?.destroy?.()
    }
  }

  async function resetDatabase(): Promise<MigrationRunSummary> {
    const { sql } = await import('drizzle-orm')

    await withAdminDb(async (adminDb) => {
      await adminDb.execute(sql.raw('DROP SCHEMA IF EXISTS public CASCADE'))
      await adminDb.execute(sql.raw('CREATE SCHEMA public'))
      await adminDb.execute(sql.raw('DROP SCHEMA IF EXISTS drizzle CASCADE'))
    })

    // A reset ends on a migrated database, like `guren db:reset`. Dropping the
    // memo re-applies from scratch; a caller that then migrates again hits the
    // fresh memo and no-ops.
    migrations.reset()
    return migrations.get()
  }

  async function migrationStatus(): Promise<MigrationStatusEntry[]> {
    const localMigrations = listLocalMigrations(resolvedMigrationsFolder)
    if (localMigrations.length === 0) return []

    const { sql } = await import('drizzle-orm')
    const appliedRows = await withAdminDb(async (adminDb) => {
      try {
        const result = (await adminDb.execute(
          sql.raw('SELECT name FROM drizzle.__drizzle_migrations'),
        )) as unknown as { rows?: Array<{ name: string | null }> } | Array<{ name: string | null }>
        const rows = Array.isArray(result) ? result : (result.rows ?? [])
        return rows.map((row) => ({ name: row.name, appliedAt: null }))
      } catch (error) {
        // Only a missing tracker table means "nothing applied". Anything else
        // (IAM denial, network) must surface — reporting it as all-pending
        // could prompt a re-run of applied migrations.
        if (isMissingTrackerTableError(error)) {
          return []
        }
        throw error
      }
    })

    return buildMigrationStatus(localMigrations, appliedRows)
  }

  return {
    getDatabase: databaseHandle.get,
    migrateDatabase: migrations.get,
    closeDatabase,
    configureOrm,
    seedDatabase,
    resetDatabase,
    migrationStatus,
  }
}

// The Data API surfaces Postgres errors as message text rather than a code,
// so the undefined-table condition has to be matched on the message.
function isMissingTrackerTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /does not exist/i.test(message) && /drizzle|__drizzle_migrations|schema/i.test(message)
}
