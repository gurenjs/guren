import { createSqliteDatabase, defineDatabaseConfig, type SqliteSeederContext } from '@guren/core'
import env from './env.js'

const database = createSqliteDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  // A pending migration that drops, narrows or renames is refused at boot and by
  // `guren db:migrate` until its first line reads `-- guren:allow-destructive: <reason>`.
  destructiveMigrations: 'refuse',
  seedersFolder: new URL('../db/seeders', import.meta.url),
  // `context` is the application's validated environment. `guren db:*` runs this
  // outside one, where report mode reads the schema without requiring the keys
  // only the web process needs (APP_KEY and APP_URL in production).
  filename: (context) => {
    const values = context?.env ?? env.parse(undefined, { mode: 'report' }).values
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
 * Seeding on boot is a local convenience, allowed by name: `bun run dev` sets
 * NODE_ENV=development and `bun test` sets test. Anything else, an unset NODE_ENV
 * included, never seeds, since seeders write demo accounts and production boots
 * repeatedly on serverless cold starts. Run `bunx guren db:seed` explicitly there.
 */
export default defineDatabaseConfig(database, {
  seedOnBoot: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
})
