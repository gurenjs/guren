import { createPostgresDatabase, defineDatabaseConfig } from '@guren/core'
import env from './env.js'

const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  // `context` is the application's validated environment; `guren db:*` runs this
  // outside one and parses the schema itself.
  connectionString: (context) => (context?.env ?? env.parse(undefined, { mode: 'report' }).values).DATABASE_URL
    ?? 'postgres://guren:guren@localhost:54322/guren',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database
export type BlogDatabase = Awaited<ReturnType<typeof getDatabase>>

/**
 * Seeding is one-shot provisioning, not part of booting: production boots again
 * on every serverless cold start, and a bundle cannot resolve db/seeders/*.ts.
 * Run `bun run db:seed` explicitly instead.
 */
export default defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' })
