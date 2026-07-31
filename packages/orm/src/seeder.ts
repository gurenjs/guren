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
 * Seeders are loaded as modules, so the dialect they were written against is
 * unknowable here. `TDatabase` is the caller stating which database it will
 * hand them — the same contract `runSeeders()` fulfils from the driver side.
 */
export async function loadSeeders<TDatabase = PostgresJsDatabase>(
  directory: string | URL,
): Promise<Array<SeederHandler<TDatabase>>> {
  const root = directory instanceof URL ? fileURLToPath(directory) : resolve(directory)
  const entries = await readdir(root, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => resolve(root, entry.name))
    .sort()

  const seeders: Array<SeederHandler<TDatabase>> = []

  for (const file of files) {
    const handler = await loadSeederModule(file)
    if (handler) {
      seeders.push(handler as SeederHandler<TDatabase>)
    }
  }

  return seeders
}

export async function runSeeders<TDatabase>(db: TDatabase, directory: string | URL): Promise<void> {
  const seeders = await loadSeeders<TDatabase>(directory)

  for (const handler of seeders) {
    await handler({ db })
  }
}

export function defineSeeder<TDatabase = PostgresJsDatabase>(
  handler: SeederHandler<TDatabase>,
): SeederHandler<TDatabase> {
  return handler
}
