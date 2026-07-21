import { createSqliteDatabase } from '@guren/orm'

// `bun test` sets NODE_ENV=test automatically, so the test suite reads and
// writes a separate SQLite file and never touches the development database —
// this takes priority over DATABASE_URL, which .env sets unconditionally.
// Override the test DB path itself with TEST_DATABASE_URL if needed (e.g. to
// shard parallel CI runs); DATABASE_URL is still authoritative outside tests.
function resolveDatabaseFilename(): string {
  if (process.env.NODE_ENV === 'test') {
    return process.env.TEST_DATABASE_URL ?? './data/guren.test.db'
  }
  return process.env.DATABASE_URL ?? './data/guren.db'
}

const database = createSqliteDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  filename: resolveDatabaseFilename,
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database
