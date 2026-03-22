import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

const drizzleMock = mock((config: Record<string, unknown>) => ({
  config,
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

function createMigrationsFolder(withMigrations: boolean): string {
  const migrationsFolder = mkdtempSync(join(tmpdir(), 'guren-orm-migrations-'))

  if (withMigrations) {
    const migrationDir = join(migrationsFolder, '20240101000000_init')
    mkdirSync(migrationDir, { recursive: true })
    writeFileSync(join(migrationDir, 'migration.sql'), '')
  }

  return migrationsFolder
}

describe('createPostgresDatabase', () => {
  it('runs migrations and returns a configured database', async () => {
    const schema = { users: {} }
    const database = createPostgresDatabase({
      schema,
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'postgres://example',
    })

    await database.migrateDatabase()
    expect(migrateMock).toHaveBeenCalled()

    const db = await database.getDatabase()
    expect(db).toMatchObject({ config: { schema } })
  })

  it('configures the Drizzle adapter', async () => {
    const schema = { users: {} }
    const database = createPostgresDatabase({
      schema,
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'postgres://example',
    })

    const originalConfigure = DrizzleAdapter.configure
    const configureSpy = mock(() => {})
    DrizzleAdapter.configure = configureSpy as typeof DrizzleAdapter.configure

    await database.configureOrm()
    expect(configureSpy).toHaveBeenCalled()

    DrizzleAdapter.configure = originalConfigure
  })

  it('skips migrations when drizzle metadata is missing', async () => {
    const migrationsFolder = createMigrationsFolder(false)
    const database = createPostgresDatabase({
      schema: {},
      migrationsFolder,
      connectionString: () => 'postgres://example',
    })

    migrateMock.mockClear()
    await database.migrateDatabase()

    expect(migrateMock).not.toHaveBeenCalled()
  })

  it('runs migrations when drizzle metadata exists', async () => {
    const migrationsFolder = createMigrationsFolder(true)
    const database = createPostgresDatabase({
      schema: {},
      migrationsFolder,
      connectionString: () => 'postgres://example',
    })

    migrateMock.mockClear()
    await database.migrateDatabase()

    expect(migrateMock).toHaveBeenCalled()
  })

  it('throws when seeders folder is missing', async () => {
    const database = createPostgresDatabase({
      schema: {},
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'postgres://example',
    })

    await expect(database.seedDatabase()).rejects.toThrow('No seeders folder configured')
  })
})
