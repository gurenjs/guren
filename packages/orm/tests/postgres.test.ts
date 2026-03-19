import { describe, expect, it, mock } from 'bun:test'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

const drizzleMock = mock((client: unknown, options: Record<string, unknown>) => ({
  client,
  options,
}))
const migrateMock = mock(async () => {})
const postgresMock = mock((_url: string, _options: Record<string, unknown>) => ({
  end: mock(async () => {}),
}))

await mock.module('drizzle-orm/postgres-js', () => ({
  drizzle: drizzleMock,
}))

await mock.module('drizzle-orm/postgres-js/migrator', () => ({
  migrate: migrateMock,
}))

await mock.module('postgres', () => ({
  default: postgresMock,
}))

const { createPostgresDatabase } = await import('../src/postgres')

describe('createPostgresDatabase', () => {
  it('runs migrations and returns a configured database', async () => {
    const schema = { users: {} }
    const database = createPostgresDatabase({
      schema,
      migrationsFolder: 'db/migrations',
      connectionString: () => 'postgres://example',
    })

    await database.migrateDatabase()
    expect(migrateMock).toHaveBeenCalled()

    const db = await database.getDatabase()
    expect(db).toMatchObject({ options: { schema } })
  })

  it('configures the Drizzle adapter', async () => {
    const schema = { users: {} }
    const database = createPostgresDatabase({
      schema,
      migrationsFolder: 'db/migrations',
      connectionString: () => 'postgres://example',
    })

    const originalConfigure = DrizzleAdapter.configure
    const configureSpy = mock(() => {})
    DrizzleAdapter.configure = configureSpy as typeof DrizzleAdapter.configure

    await database.configureOrm()
    expect(configureSpy).toHaveBeenCalled()

    DrizzleAdapter.configure = originalConfigure
  })

  it('throws when seeders folder is missing', async () => {
    const database = createPostgresDatabase({
      schema: {},
      migrationsFolder: 'db/migrations',
      connectionString: () => 'postgres://example',
    })

    await expect(database.seedDatabase()).rejects.toThrow('No seeders folder configured')
  })
})
