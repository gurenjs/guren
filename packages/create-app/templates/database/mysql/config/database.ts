import { createMySqlDatabase, defineDatabaseConfig, type MySqlSeederContext } from '@guren/core'
import env from './env.js'

const database = createMySqlDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  // `context` is the application's validated environment. `guren db:*` runs this
  // outside one, where report mode reads the schema without requiring the keys
  // only the web process needs (APP_KEY and APP_URL in production).
  connectionString: (context) => (context?.env ?? env.parse(undefined, { mode: 'report' }).values).DATABASE_URL
    ?? 'mysql://guren:guren@localhost:33306/guren',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database

/** Annotate seeders with this: `defineSeeder(async ({ db }: AppSeederContext) => {})`. */
export type AppSeederContext = MySqlSeederContext

/**
 * Seeding is one-shot provisioning, not part of booting: production boots
 * repeatedly on serverless cold starts, and a bundle has no resolver for the
 * raw db/seeders/*.ts files. Run `bunx guren db:seed` explicitly instead.
 */
export default defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' })
