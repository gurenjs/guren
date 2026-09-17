import { createD1Database, createSqliteDatabase } from '@guren/core'
import { getWorkersEnv, isWorkersRuntime } from '@guren/plugin-cloudflare/env'

import env from './env.js'
import type { WorkersEnv } from './workers-env.js'

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
      // `context` is the application's validated environment; `guren db:*` runs this
      // outside one and parses the schema itself.
      filename: (context) => (context?.env ?? env.parse(undefined, { mode: 'report' }).values).SQLITE_DATABASE_PATH,
    })

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database
