import { createD1Database, createSqliteDatabase } from '@guren/core'
import { isWorkersRuntime } from '@guren/plugin-cloudflare/env'

const database = isWorkersRuntime()
  ? createD1Database({
      binding: 'DB',
      migrationsFolder: new URL('../db/migrations', import.meta.url),
    })
  : createSqliteDatabase({
      migrationsFolder: new URL('../db/migrations', import.meta.url),
      seedersFolder: new URL('../db/seeders', import.meta.url),
      // Not DATABASE_URL: that name carries a Postgres URI in existing
      // environments, which the sqlite factory would read as a file path.
      filename: () => process.env.SQLITE_DATABASE_PATH || './data/agents.db',
    })

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database
