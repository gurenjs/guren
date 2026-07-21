import { createSqliteDatabase } from '@guren/orm'

// `bun test` sets NODE_ENV=test automatically, so the test suite reads and
// writes a separate SQLite file and never touches the development database.
// DATABASE_URL always wins when set (e.g. in CI or production).
function resolveDatabaseFilename(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL
  }
  return process.env.NODE_ENV === 'test' ? './data/guren.test.db' : './data/guren.db'
}

const database = createSqliteDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  filename: resolveDatabaseFilename,
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database
