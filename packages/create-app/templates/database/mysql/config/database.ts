import { createMySqlDatabase, defineDatabaseConfig, type MySqlSeederContext } from '@guren/core'
import env from './env.js'

const database = createMySqlDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  // `context` is the application's validated environment. drizzle-kit and
  // `guren db:*` run this outside an application, so the schema is parsed here.
  connectionString: (context) => (context?.env ?? env.parse().values).DATABASE_URL
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
