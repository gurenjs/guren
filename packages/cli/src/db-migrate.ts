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
 * What the app's `migrateDatabase()` reported. Mirrors `MigrationRunSummary`
 * from `@guren/orm` but is read structurally, because the config module belongs
 * to the app and may be backed by an older ORM or a hand-written function.
 * Nothing pins the two shapes together: a field added to the ORM's summary has
 * to be added here too before the CLI can see it.
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
 * What the app's `seedDatabase()` reported. Mirrors `SeederRunSummary` from
 * `@guren/orm`, read structurally for the same reason as
 * {@link MigrationRunSummary}.
 */
export interface SeederRunSummary {
  seedersFolder?: string
  seedersRan: number
  filesWithoutSeeder: number
}

function asSeederRunSummary(value: unknown): SeederRunSummary | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const { seedersFolder, seedersRan, filesWithoutSeeder } = value
  if (typeof seedersRan !== 'number') {
    return undefined
  }

  return {
    seedersFolder: typeof seedersFolder === 'string' ? seedersFolder : undefined,
    seedersRan,
    filesWithoutSeeder: typeof filesWithoutSeeder === 'number' ? filesWithoutSeeder : 0,
  }
}

/**
 * Runs the app's migrations. Undefined when the app's ORM reports nothing —
 * an older `@guren/orm`, or a hand-written migration function.
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

/**
 * Runs the app's seeders. Undefined when the app's ORM reports nothing — an
 * older `@guren/orm`, or a hand-written seed function.
 */
export async function runDatabaseSeeders(): Promise<SeederRunSummary | undefined> {
  const module = await resolveDatabaseModule()
  const seed = pickFunction(module, ['seedDatabase', 'runSeeders'])
  const close = pickFunction(module, ['closeDatabase'])

  if (!seed) {
    throw new Error('config/database.ts must export seedDatabase() or runSeeders().')
  }

  try {
    return asSeederRunSummary(await seed())
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
 * What a reset run reported, half by half. Either field is absent when the
 * app's config reported nothing for it; `seeders` is also absent when the run
 * was not asked to seed, which is not the same as seeding nothing. Being asked
 * to seed a config that cannot throws before anything is dropped.
 */
export interface ResetRunSummary {
  migrations?: MigrationRunSummary
  seeders?: SeederRunSummary
}

/**
 * Drops the schema, re-applies migrations, and optionally seeds. Reports the
 * same summaries as `runDatabaseMigrations()`/`runDatabaseSeeders()`: a reset
 * that finds no migrations leaves an empty database behind.
 */
export async function resetDatabase(options: ResetDatabaseOptions = {}): Promise<ResetRunSummary> {
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

  // Checked before reset() drops anything: the alternative is to empty the
  // database and then report a seed that never ran.
  if (options.seed && !seed) {
    throw new Error('config/database.ts must export seedDatabase() or runSeeders().')
  }

  try {
    const summary = asMigrationRunSummary(await reset())
    // `reset()` already re-applies migrations; this second call hits the
    // driver's memo and no-ops, and exists for a config exporting only a bare
    // dropAllTables() — the one case the fallback below describes.
    const migrated = asMigrationRunSummary(await migrate())

    // `seed` is present whenever options.seed is — the guard above threw
    // otherwise; the test is here only so it narrows.
    const seeders = options.seed && seed ? asSeederRunSummary(await seed()) : undefined

    return { migrations: summary ?? migrated, seeders }
  } finally {
    if (close) {
      await close()
    }
  }
}
