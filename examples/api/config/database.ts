import { createPostgresDatabase, defineDatabaseConfig } from '@guren/core'
import env from './env.js'

const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  // `context` is the application's validated environment; `guren db:*` runs this
  // outside one and parses the schema itself.
  connectionString: (context) => (context?.env ?? env.parse(undefined, { mode: 'report' }).values).DATABASE_URL
    ?? 'postgres://guren:guren@localhost:54322/guren_api',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database
export type ApiDatabase = Awaited<ReturnType<typeof getDatabase>>

/**
 * Seeding on boot is allowed by name: `bun run dev` sets NODE_ENV=development and
 * the test runner sets test. Anything else, an unset NODE_ENV included, never
 * seeds; production boots again on every serverless cold start, and a bundle
 * cannot resolve db/seeders/*.ts. Run `bun run db:seed` explicitly there.
 */
export default defineDatabaseConfig(database, {
  seedOnBoot: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
})
