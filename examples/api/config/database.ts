import { createPostgresDatabase } from '@guren/orm'

const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  connectionString: () => process.env.DATABASE_URL || 'postgres://guren:guren@localhost:54322/guren_api',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database
export type ApiDatabase = Awaited<ReturnType<typeof getDatabase>>
