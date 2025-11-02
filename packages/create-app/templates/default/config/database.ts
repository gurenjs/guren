import { createPostgresDatabase } from '@guren/orm'
import * as schema from '../db/schema.js'

const database = createPostgresDatabase({
  schema,
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  connectionString: () => process.env.DATABASE_URL ?? 'postgres://guren:guren@localhost:54322/guren',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database
