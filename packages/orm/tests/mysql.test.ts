import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

const drizzleMock = mock((config: unknown) => ({
  $client: {
    end: mock((cb?: (err?: unknown) => void) => {
      cb?.()
      return undefined
    }),
  },
  config,
}))
const migrateMock = mock(async () => {})

await mock.module('drizzle-orm/mysql2', () => ({
  drizzle: drizzleMock,
}))

await mock.module('drizzle-orm/mysql2/migrator', () => ({
  migrate: migrateMock,
}))

const { createMySqlDatabase } = await import('../src/mysql')

function createMigrationsFolder(withMigrations: boolean): string {
  const migrationsFolder = mkdtempSync(join(tmpdir(), 'guren-orm-mysql-migrations-'))

  if (withMigrations) {
    const migrationDir = join(migrationsFolder, '20240101000000_init')
    mkdirSync(migrationDir, { recursive: true })
    writeFileSync(join(migrationDir, 'migration.sql'), '')
  }

  return migrationsFolder
}

describe('createMySqlDatabase', () => {
  it('runs migrations and returns a configured database', async () => {
    const database = createMySqlDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'mysql://example',
    })

    await database.migrateDatabase()
    expect(migrateMock).toHaveBeenCalled()

    const db = await database.getDatabase()
    expect(db).toMatchObject({
      config: {
        connection: { uri: 'mysql://example' },
        mode: 'default',
      },
    })
  })

  it('configures the Drizzle adapter', async () => {
    const database = createMySqlDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'mysql://example',
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
    const database = createMySqlDatabase({
      migrationsFolder,
      connectionString: () => 'mysql://example',
    })

    migrateMock.mockClear()
    await database.migrateDatabase()

    expect(migrateMock).not.toHaveBeenCalled()
  })

  it('runs migrations when drizzle metadata exists', async () => {
    const migrationsFolder = createMigrationsFolder(true)
    const database = createMySqlDatabase({
      migrationsFolder,
      connectionString: () => 'mysql://example',
    })

    migrateMock.mockClear()
    await database.migrateDatabase()

    expect(migrateMock).toHaveBeenCalled()
  })

  it('throws when seeders folder is missing', async () => {
    const database = createMySqlDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'mysql://example',
    })

    await expect(database.seedDatabase()).rejects.toThrow('No seeders folder configured')
  })
})
