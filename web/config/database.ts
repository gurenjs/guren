import { createD1Database, createSqliteDatabase } from '@guren/core'
import { getWorkersEnv } from '@guren/plugin-cloudflare'

interface WorkersEnv {
  DB: unknown
}

/** workerd identifies itself through the standard navigator user agent. */
export function isWorkersRuntime(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'
}

const database = isWorkersRuntime()
  ? createD1Database({
      binding: () => getWorkersEnv<WorkersEnv>().DB,
      migrationsFolder: new URL('../db/migrations', import.meta.url),
    })
  : createSqliteDatabase({
      migrationsFolder: new URL('../db/migrations', import.meta.url),
      seedersFolder: new URL('../db/seeders', import.meta.url),
      // Not DATABASE_URL: that name carries a Postgres URI in existing
      // environments, which the sqlite factory would read as a file path.
      filename: () => process.env.SQLITE_DATABASE_PATH || './data/guren.db',
    })

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database
