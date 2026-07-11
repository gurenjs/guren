import { createSqliteDatabase } from '@guren/orm'

const database = createSqliteDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  filename: () => process.env.DATABASE_URL ?? './data/guren.db',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database
