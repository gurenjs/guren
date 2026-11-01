import { createMySqlDatabase, defineDatabaseConfig, type MySqlSeederContext } from '@guren/core'
import env from './env.js'

const database = createMySqlDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  // A pending migration that drops, narrows or renames is refused at boot and by
  // `guren db:migrate` until its first line reads `-- guren:allow-destructive: <reason>`.
  destructiveMigrations: 'refuse',
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
 * Seeding on boot is a local convenience, allowed by name: `bun run dev` sets
 * NODE_ENV=development and `bun test` sets test. Anything else, an unset NODE_ENV
 * included, never seeds, since seeders write demo accounts and production boots
 * repeatedly on serverless cold starts. Run `bunx guren db:seed` explicitly there.
 */
export default defineDatabaseConfig(database, {
  seedOnBoot: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
})
