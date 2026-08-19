import { readdir } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AwsDataApiPgDatabase } from 'drizzle-orm/aws-data-api/pg'
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const SUPPORTED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts'])

/**
 * The context a seeder receives. `db` is the drizzle database the app
 * configured, so its type depends on the dialect: annotate the seeder with the
 * matching alias below (or pass the driver's own database type) whenever the
 * app is not on PostgreSQL.
 *
 * The type parameter defaults to `PostgresJsDatabase` for backwards
 * compatibility — seeders written before this was generic keep compiling.
 */
export interface SeederContext<TDatabase = PostgresJsDatabase> {
  db: TDatabase
}

export type SeederHandler<TDatabase = PostgresJsDatabase> = (context: SeederContext<TDatabase>) => unknown

// Every driver whose `seedDatabase()` runs seeders gets an alias here. D1 has
// none on purpose: its seeding happens through wrangler, and `seedDatabase()`
// throws rather than handing a database to a seeder.

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
 * this rather than off the call returning: a folder with no seeders in it seeds
 * nothing, and saying "executed" there reads as a database that now holds the
 * rows the seeders would have written.
 */
export interface SeederRunSummary {
  /** The folder that was read, absolute as the driver resolved it. */
  seedersFolder: string
  /** Seeders that ran, in the order their files sorted. */
  seedersRan: number
  /**
   * Files with a seeder extension that exported nothing runnable, so they were
   * skipped. Non-zero alongside `seedersRan: 0` means the folder is not empty
   * but holds nothing to run — a different problem from having written no
   * seeder yet, and one `make:seeder` would not solve.
   */
  filesWithoutSeeder: number
}

/**
 * One read of the seeders folder: the handlers it yielded, and the files that
 * yielded none. Kept together because they come from the same listing — the
 * skipped count cannot be recovered from the handler array alone.
 */
async function collectSeeders<TDatabase>(
  directory: string | URL,
): Promise<{ root: string; seeders: Array<SeederHandler<TDatabase>>; filesWithoutSeeder: number }> {
  const root = directory instanceof URL ? fileURLToPath(directory) : resolve(directory)
  const entries = await readdir(root, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => resolve(root, entry.name))
    .sort()

  const seeders: Array<SeederHandler<TDatabase>> = []
  let filesWithoutSeeder = 0

  for (const file of files) {
    const handler = await loadSeederModule(file)
    if (handler) {
      seeders.push(handler as SeederHandler<TDatabase>)
    } else {
      filesWithoutSeeder += 1
    }
  }

  return { root, seeders, filesWithoutSeeder }
}

/**
 * Seeders are loaded as modules, so the dialect they were written against is
 * unknowable here. `TDatabase` is the caller stating which database it will
 * hand them — the same contract `runSeeders()` fulfils from the driver side.
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
