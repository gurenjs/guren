import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

let executeImpl: () => Promise<unknown> = async () => [[]]
const drizzleMock = mock((config: unknown) => ({
  $client: {
    end: mock((cb?: (err?: unknown) => void) => {
      cb?.()
      return undefined
    }),
  },
  execute: () => executeImpl(),
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
  afterEach(() => {
    executeImpl = async () => [[]]
  })

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

  it('reports an unreachable server instead of the query drizzle was running', async () => {
    const database = createMySqlDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'mysql://guren:hunter2@db.internal:33306/guren',
    })

    migrateMock.mockImplementationOnce(async () => {
      throw new Error('Failed query: CREATE TABLE `__drizzle_migrations`', {
        cause: Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
      })
    })

    const error = await database.migrateDatabase().then(
      () => null,
      (reason: unknown) => reason as Error,
    )

    expect(error?.message).toBe(
      'Failed to run database migrations: cannot connect to the database at db.internal:33306 (ECONNREFUSED). Is it running and accepting connections?',
    )
    // Canary: keeps the credential check alive if the assertion above is
    // ever loosened from toBe to toContain.
    expect(error?.message).not.toContain('hunter2')
  })

  it('reports an unreachable server from db:status instead of calling every migration pending', async () => {
    const database = createMySqlDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'mysql://guren:hunter2@db.internal:33306/guren',
    })

    executeImpl = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', syscall: 'connect' })
    }

    const error = await database.migrationStatus().then(
      () => null,
      (reason: unknown) => reason as Error,
    )

    expect(error?.message).toBe(
      'cannot connect to the database at db.internal:33306 (ECONNREFUSED). Is it running and accepting connections?',
    )
  })

  it('still reports nothing applied when only the tracker table is missing', async () => {
    const database = createMySqlDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'mysql://guren:hunter2@db.internal:33306/guren',
    })

    executeImpl = async () => {
      throw Object.assign(new Error("Table 'guren.__drizzle_migrations' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' })
    }

    expect(await database.migrationStatus()).toEqual([
      { name: '20240101000000_init', applied: false, appliedAt: null },
    ])
  })

  it('throws when seeders folder is missing', async () => {
    const database = createMySqlDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'mysql://example',
    })

    await expect(database.seedDatabase()).rejects.toThrow('No seeders folder configured')
  })
})
