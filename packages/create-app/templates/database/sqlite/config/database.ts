import { createSqliteDatabase, defineDatabaseConfig, type SqliteSeederContext } from '@guren/core'
import env from './env.js'

const database = createSqliteDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  // `context` is the application's validated environment. drizzle-kit and
  // `guren db:*` run this outside an application, so the schema is parsed here.
  filename: (context) => {
    const values = context?.env ?? env.parse().values
    // `bun test` sets NODE_ENV=test automatically, so the test suite reads and
    // writes a separate SQLite file and never touches the development database.
    // This takes priority over DATABASE_URL, which .env sets unconditionally.
    return process.env.NODE_ENV === 'test'
      ? values.TEST_DATABASE_URL ?? './data/guren.test.db'
      : values.DATABASE_URL ?? './data/guren.db'
  },
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database

/** Annotate seeders with this: `defineSeeder(async ({ db }: AppSeederContext) => {})`. */
export type AppSeederContext = SqliteSeederContext

/**
 * Seeding is one-shot provisioning, not part of booting: production boots
 * repeatedly on serverless cold starts, and a bundle has no resolver for the
 * raw db/seeders/*.ts files. Run `bunx guren db:seed` explicitly instead.
 */
export default defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' })
