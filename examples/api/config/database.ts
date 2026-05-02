import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPostgresDatabase } from '@guren/orm'

const seedersFolder = new URL('../db/seeders', import.meta.url)
export const hasSeeders = existsSync(fileURLToPath(seedersFolder))

const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: hasSeeders ? seedersFolder : undefined,
  connectionString: () => process.env.DATABASE_URL ?? 'postgres://guren:guren@localhost:54322/guren_api',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database
export type ApiDatabase = Awaited<ReturnType<typeof getDatabase>>
