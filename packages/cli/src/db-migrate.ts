import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isRecord } from './runtime'

const DATABASE_CONFIG_CANDIDATES = [
  'config/database.ts',
  'config/database.js',
  'config/database.mjs',
  'config/database.cjs',
]

async function importModule(path: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(path).href
  return import(url)
}

export async function resolveDatabaseModule(): Promise<Record<string, unknown>> {
  const cwd = process.cwd()

  for (const candidate of DATABASE_CONFIG_CANDIDATES) {
    const absolutePath = resolve(cwd, candidate)

    try {
      await access(absolutePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }

      throw error
    }

    return importModule(absolutePath)
  }

  throw new Error('Could not find config/database.(ts|js) in the current working directory.')
}

function pickFunction(module: Record<string, unknown>, names: string[]): (() => Promise<unknown>) | undefined {
  for (const name of names) {
    const value = module[name as keyof typeof module]
    if (typeof value === 'function') {
      return value as () => Promise<unknown>
    }
  }

  const defaultExport = module.default
  if (defaultExport && typeof defaultExport === 'object') {
    for (const name of names) {
      const value = (defaultExport as Record<string, unknown>)[name]
      if (typeof value === 'function') {
        return value as () => Promise<unknown>
      }
    }
  }

  return undefined
}

/**
 * What the app's `migrateDatabase()` reported about the run. Mirrors
 * `MigrationRunSummary` from `@guren/orm`, but declared here and read
 * structurally rather than imported: the config module belongs to the app, so
 * it may be backed by an older ORM that resolves to undefined, or by a
 * migration function the user wrote themselves. The cost of that decoupling is
 * that nothing pins the two shapes together — a field added to the ORM's
 * summary has to be added here too before the CLI can see it.
 */
export interface MigrationRunSummary {
  migrationsFolder?: string
  migrationsFound: number
  looseSqlFiles: number
}

function asMigrationRunSummary(value: unknown): MigrationRunSummary | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const { migrationsFolder, migrationsFound, looseSqlFiles } = value
  if (typeof migrationsFound !== 'number') {
    return undefined
  }

  return {
    migrationsFolder: typeof migrationsFolder === 'string' ? migrationsFolder : undefined,
    migrationsFound,
    looseSqlFiles: typeof looseSqlFiles === 'number' ? looseSqlFiles : 0,
  }
}

/**
 * Runs the app's migrations. Returns what the run found when the app's ORM
 * reports it, and undefined when it does not — an older `@guren/orm`, or a
 * `config/database.ts` exporting a migration function of its own.
 */
export async function runDatabaseMigrations(): Promise<MigrationRunSummary | undefined> {
  const module = await resolveDatabaseModule()
  const migrate = pickFunction(module, ['migrateDatabase', 'runMigrations', 'getDatabase'])
  const close = pickFunction(module, ['closeDatabase'])

  if (!migrate) {
    throw new Error('config/database.ts must export migrateDatabase(), runMigrations(), or getDatabase().')
  }

  try {
    return asMigrationRunSummary(await migrate())
  } finally {
    if (close) {
      await close()
    }
  }
}

export async function runDatabaseSeeders(): Promise<void> {
  const module = await resolveDatabaseModule()
  const seed = pickFunction(module, ['seedDatabase', 'runSeeders'])
  const close = pickFunction(module, ['closeDatabase'])

  if (!seed) {
    throw new Error('config/database.ts must export seedDatabase() or runSeeders().')
  }

  try {
    await seed()
  } finally {
    if (close) {
      await close()
    }
  }
}

export interface ResetDatabaseOptions {
  /** Run seeders after migrations (default: false) */
  seed?: boolean
}

/**
 * Drops the schema and re-applies migrations. Returns the same summary
 * `runDatabaseMigrations()` does for the migration half of the run: a reset
 * that finds no migrations leaves an empty database behind, which is worth
 * reporting rather than calling done.
 */
export async function resetDatabase(options: ResetDatabaseOptions = {}): Promise<MigrationRunSummary | undefined> {
  const module = await resolveDatabaseModule()
  const reset = pickFunction(module, ['resetDatabase', 'dropAllTables'])
  const migrate = pickFunction(module, ['migrateDatabase', 'runMigrations', 'getDatabase'])
  const seed = pickFunction(module, ['seedDatabase', 'runSeeders'])
  const close = pickFunction(module, ['closeDatabase'])

  if (!reset) {
    throw new Error('config/database.ts must export resetDatabase() or dropAllTables() to use db:reset.')
  }

  if (!migrate) {
    throw new Error('config/database.ts must export migrateDatabase(), runMigrations(), or getDatabase().')
  }

  try {
    const summary = asMigrationRunSummary(await reset())
    // `reset()` already re-applies migrations; this second call hits the
    // driver's memo and no-ops, and exists for a config that only exports a
    // bare dropAllTables() — which is also the only case the fallback below
    // describes, since a driver reset that reports nothing ran nothing.
    const migrated = asMigrationRunSummary(await migrate())

    if (options.seed && seed) {
      await seed()
    }

    return summary ?? migrated
  } finally {
    if (close) {
      await close()
    }
  }
}
