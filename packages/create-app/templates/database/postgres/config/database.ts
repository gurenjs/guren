import { createPostgresDatabase, type PostgresSeederContext } from '@guren/orm'

const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  connectionString: () => process.env.DATABASE_URL ?? 'postgres://guren:guren@localhost:54322/guren',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database

/** Annotate seeders with this: `defineSeeder(async ({ db }: AppSeederContext) => {})`. */
export type AppSeederContext = PostgresSeederContext
