import { createSqliteDatabase } from '@guren/orm'
import * as schema from '../db/schema.js'

const database = createSqliteDatabase({
  schema,
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  filename: () => process.env.DATABASE_URL ?? './data/guren.db',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database
