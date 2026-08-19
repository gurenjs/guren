import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { singleFlight } from './single-flight'

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
  migrateDatabase(): Promise<never>
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

  // Display-only (wrangler owns the folder): keep strings as the caller wrote
  // them and relativize URLs, so error guidance never leaks a machine-specific
  // absolute path into a copy-pasteable wrangler.jsonc value.
  const migrationsHint =
    migrationsFolder == null
      ? 'db/migrations'
      : migrationsFolder instanceof URL
        ? relative(process.cwd(), fileURLToPath(migrationsFolder))
        : migrationsFolder

  const databaseHandle = singleFlight(async (): Promise<unknown> => {
    const client = binding()
    if (client == null) {
      throw new Error(
        'createD1Database: the "binding" resolver returned no D1 binding. ' +
          'On Workers this usually means it ran before the first request — defer access ' +
          '(e.g. binding: () => getWorkersEnv<Env>().DB) and check the d1_databases entry in wrangler.jsonc.',
      )
    }

    // drizzle-orm/d1 only accepts the positional (client, config) form —
    // unlike bun-sqlite there is no `{ client }` object overload.
    const { drizzle } = await import('drizzle-orm/d1')
    type D1Client = Parameters<typeof drizzle>[0]
    type D1Config = NonNullable<Parameters<typeof drizzle>[1]>
    return drizzle(client as D1Client, relations ? ({ relations } as D1Config) : undefined)
  })

  return {
    getDatabase: databaseHandle.get,

    async migrateDatabase() {
      // The drizzle-kit SQL ↔ wrangler format contract is covered by the
      // opt-in e2e test in packages/plugin-cloudflare/src/wrangler-migrations.test.ts
      // (GUREN_TEST_WRANGLER=1); keep its hand-written fixtures in sync with
      // drizzle-kit output when migration generation changes.
      throw new Error(
        'D1 migrations are not applied at runtime. Run `wrangler d1 migrations apply <database>` ' +
          `(local: add --local) with d1_databases[].migrations_dir pointing at ${migrationsHint}.`,
      )
    },

    async closeDatabase() {
      // D1 sessions have no connection to close; just drop the cached instance
      // (mirrors the sqlite factory).
      databaseHandle.reset()
    },

    async configureOrm() {
      const database = await databaseHandle.get()
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
