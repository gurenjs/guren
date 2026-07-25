import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DrizzleAdapter } from './adapters/drizzle-adapter'

export interface D1DatabaseOptions {
  /**
   * Resolver returning the Cloudflare D1 binding. Bindings arrive with the
   * first request on Workers, so this must be a deferred closure, e.g.
   * `binding: () => getWorkersEnv<Env>().DB`.
   */
  binding: () => unknown
  /**
   * Drizzle-kit migrations folder. D1 migrations are applied out-of-band via
   * `wrangler d1 migrations apply` (point `d1_databases[].migrations_dir` at
   * this folder); the factory only references it in error guidance.
   */
  migrationsFolder?: string | URL
  /**
   * Drizzle relations for RQB v2 (`db.query.*`).
   * Build with `defineRelations(schema, ...)` from `drizzle-orm`,
   * or with `relations()` from `drizzle-orm/_relations` for the RQB v1 partial-upgrade path.
   */
  relations?: Record<string, unknown>
}

export interface D1DatabaseHandle {
  getDatabase(): Promise<unknown>
  /** Always throws: D1 migrations are applied with `wrangler d1 migrations apply`, never at runtime. */
  migrateDatabase(): Promise<void>
  closeDatabase(): Promise<void>
  configureOrm(): Promise<void>
  /** Always throws: seed with SQL through `wrangler d1 execute`. */
  seedDatabase(): Promise<void>
  /** Always throws: recreate the database with wrangler instead. */
  resetDatabase(): Promise<void>
  /** Always throws: wrangler's tracker is authoritative — use `wrangler d1 migrations list`. */
  migrationStatus(): Promise<never>
}

/**
 * Cloudflare D1 database factory. D1 speaks the SQLite dialect, so schemas
 * written for `createSqliteDatabase` port unchanged; only the connection and
 * the migration workflow differ (wrangler owns migrations, see RFC 0003).
 */
export function createD1Database(options: D1DatabaseOptions): D1DatabaseHandle {
  const { binding, migrationsFolder, relations } = options

  const migrationsHint =
    migrationsFolder == null
      ? 'db/migrations'
      : migrationsFolder instanceof URL
        ? fileURLToPath(migrationsFolder)
        : resolve(String(migrationsFolder))

  let db: unknown

  async function ensureDatabase(): Promise<unknown> {
    if (db) return db

    const client = binding()
    if (client == null) {
      throw new Error(
        'createD1Database: the "binding" resolver returned no D1 binding. ' +
          'On Workers this usually means it ran before the first request — defer access ' +
          '(e.g. binding: () => getWorkersEnv<Env>().DB) and check the d1_databases entry in wrangler.jsonc.',
      )
    }

    const { drizzle } = await import('drizzle-orm/d1')
    type DrizzleConfig = NonNullable<Exclude<Parameters<typeof drizzle>[0], string>>
    db = drizzle({ client, ...(relations ? { relations } : {}) } as DrizzleConfig)
    return db
  }

  return {
    getDatabase: ensureDatabase,

    async migrateDatabase() {
      throw new Error(
        'D1 migrations are not applied at runtime. Run `wrangler d1 migrations apply <database>` ' +
          `(local: add --local) with d1_databases[].migrations_dir pointing at ${migrationsHint}.`,
      )
    },

    async closeDatabase() {
      // D1 sessions have no connection to close; just drop the cached instance.
      db = undefined
    },

    async configureOrm() {
      const database = await ensureDatabase()
      DrizzleAdapter.configure(database as Parameters<typeof DrizzleAdapter.configure>[0])
    },

    async seedDatabase() {
      throw new Error(
        'D1 seeding runs outside the Worker: generate SQL and apply it with ' +
          '`wrangler d1 execute <database> --file <seed.sql>` (local: add --local).',
      )
    },

    async resetDatabase() {
      throw new Error(
        'D1 databases are reset with wrangler, not at runtime: delete and recreate the database ' +
          '(`wrangler d1 delete` / `wrangler d1 create`), then re-apply migrations with `wrangler d1 migrations apply`.',
      )
    },

    async migrationStatus() {
      throw new Error(
        "Wrangler's migration tracker is authoritative for D1. Use `wrangler d1 migrations list <database>` instead.",
      )
    },
  }
}
