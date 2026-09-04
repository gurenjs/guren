import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AwsDataApiPgDatabase } from 'drizzle-orm/aws-data-api/pg'
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const SUPPORTED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts'])

// A .d.ts has a supported extension but no runtime exports, so it would count
// as a file that failed to export a handler and suppress the `make:seeder`
// hint for a folder that genuinely has no seeder.
const DECLARATION_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts']

function isSeederCandidate(name: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(name)) && !DECLARATION_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/**
 * The context a seeder receives. `db`'s type depends on the dialect: annotate
 * the seeder with the matching alias below whenever the app is not on
 * PostgreSQL, which is the default only for backwards compatibility.
 */
export interface SeederContext<TDatabase = PostgresJsDatabase> {
  db: TDatabase
}

export type SeederHandler<TDatabase = PostgresJsDatabase> = (context: SeederContext<TDatabase>) => unknown

// Every driver whose `seedDatabase()` runs seeders gets an alias here. D1 has
// none on purpose: it seeds through wrangler and `seedDatabase()` throws.

/** Seeder context for apps created with `createPostgresDatabase()`. */
export type PostgresSeederContext = SeederContext<PostgresJsDatabase>

/** Seeder context for apps created with `createMySqlDatabase()`. */
export type MySqlSeederContext = SeederContext<MySql2Database>

/** Seeder context for apps created with `createSqliteDatabase()`. */
export type SqliteSeederContext = SeederContext<SQLiteBunDatabase>

/** Seeder context for apps created with `createAwsDataApiDatabase()`. */
export type AwsDataApiSeederContext = SeederContext<AwsDataApiPgDatabase>

function normalizeSeeder(candidate: unknown): SeederHandler | undefined {
  if (!candidate) {
    return undefined
  }

  if (typeof candidate === 'function') {
    if ('prototype' in candidate && typeof (candidate as { prototype: unknown }).prototype === 'object') {
      const prototype = (candidate as { prototype: Record<string, unknown> }).prototype
      if (prototype && typeof prototype.run === 'function') {
        return async (context: SeederContext) => {
          const instance = new (candidate as new () => { run(ctx: SeederContext): unknown })()
          await instance.run(context)
        }
      }
    }

    return candidate as SeederHandler
  }

  if (typeof candidate === 'object') {
    const run = (candidate as Record<string, unknown>).run
    if (typeof run === 'function') {
      return run as SeederHandler
    }
  }

  return undefined
}

async function loadSeederModule(path: string): Promise<SeederHandler | undefined> {
  const module = await import(pathToFileURL(path).href)
  const candidates = [
    module.default,
    module.seed,
    module.run,
    module.Seeder,
    module.default && typeof module.default === 'object' ? (module.default as Record<string, unknown>).run : undefined,
  ]

  for (const candidate of candidates) {
    const handler = normalizeSeeder(candidate)
    if (handler) {
      return handler
    }
  }

  return undefined
}

/**
 * What one `runSeeders()` call had to work with. `db:seed` reports success off
 * this, not off the call returning: an empty folder seeds nothing, and
 * "executed" there reads as a database that now holds the seeded rows.
 */
export interface SeederRunSummary {
  /** The folder that was read, absolute as the driver resolved it. */
  seedersFolder: string
  /** How many seeders ran. They run in the order their files sorted. */
  seedersRan: number
  /**
   * Files with a seeder extension that exported nothing runnable. Non-zero
   * alongside `seedersRan: 0` means the folder holds nothing to run — a
   * different problem from having written no seeder, which `make:seeder` fixes.
   */
  filesWithoutSeeder: number
}

/** One read of the folder: the handlers it yielded, and the files that yielded none. */
async function collectSeeders<TDatabase>(
  directory: string | URL,
): Promise<{ root: string; seeders: Array<SeederHandler<TDatabase>>; filesWithoutSeeder: number }> {
  const root = directory instanceof URL ? fileURLToPath(directory) : resolve(directory)

  // A folder that was never created is the same nothing-to-run an empty one
  // reports; letting the ENOENT out surfaced it as "Failed to seed the
  // database: ENOENT ... scandir". Only ENOENT is absence, and it is read off
  // the listing rather than a preceding existsSync, which answers false for a
  // folder whose *parent* is unreadable and would turn a permission problem
  // into a silent "no seeders found". ENOTDIR and EACCES still throw.
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw error
    }
    return { root, seeders: [], filesWithoutSeeder: 0 }
  }

  const files = entries
    .filter((entry) => entry.isFile() && isSeederCandidate(entry.name))
    .map((entry) => resolve(root, entry.name))
    .sort()

  const seeders: Array<SeederHandler<TDatabase>> = []

  for (const file of files) {
    const handler = await loadSeederModule(file)
    if (handler) {
      seeders.push(handler as SeederHandler<TDatabase>)
    }
  }

  return { root, seeders, filesWithoutSeeder: files.length - seeders.length }
}

/**
 * Seeders load as modules, so their dialect is unknowable here: `TDatabase` is
 * the caller stating which database it will hand them.
 */
export async function loadSeeders<TDatabase = PostgresJsDatabase>(
  directory: string | URL,
): Promise<Array<SeederHandler<TDatabase>>> {
  return (await collectSeeders<TDatabase>(directory)).seeders
}

/** Runs every seeder in `directory` and reports what the folder held. */
export async function runSeeders<TDatabase>(
  db: TDatabase,
  directory: string | URL,
): Promise<SeederRunSummary> {
  const { root, seeders, filesWithoutSeeder } = await collectSeeders<TDatabase>(directory)

  for (const handler of seeders) {
    await handler({ db })
  }

  return { seedersFolder: root, seedersRan: seeders.length, filesWithoutSeeder }
}

export function defineSeeder<TDatabase = PostgresJsDatabase>(
  handler: SeederHandler<TDatabase>,
): SeederHandler<TDatabase> {
  return handler
}
