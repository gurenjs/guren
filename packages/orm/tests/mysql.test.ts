import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

// Annotated because `end` reads `pool` from its own initializer.
interface FakePool {
  ended: boolean
  end(callback?: (error?: unknown) => void): void
}

let executeImpl: () => Promise<unknown> = async () => [[]]
const createdPools: FakePool[] = []
const createPoolMock = mock(() => {
  const pool: FakePool = {
    ended: false,
    end(callback) {
      pool.ended = true
      callback?.()
    },
  }
  createdPools.push(pool)
  return pool
})
const drizzleMock = mock((config: unknown) => ({
  execute: () => executeImpl(),
  config,
}))
const migrateMock = mock(async () => {})

await mock.module('mysql2', () => ({
  createPool: createPoolMock,
}))

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
    createdPools.length = 0
  })

  it('runs migrations and hands drizzle a pool it owns', async () => {
    const database = createMySqlDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'mysql://example',
      clientOptions: { connectTimeout: 1234 },
    })

    await database.migrateDatabase()
    expect(migrateMock).toHaveBeenCalled()

    const db = await database.getDatabase()
    expect(createPoolMock).toHaveBeenLastCalledWith({ uri: 'mysql://example', connectTimeout: 1234 })

    const [migrationPool, activePool] = createdPools
    // The migration pool is short-lived and must not outlive the migration.
    expect(migrationPool?.ended).toBe(true)
    // `client`, not `connection`: drizzle must be handed the pool we built.
    expect((db as unknown as { config: { client: unknown } }).config.client).toBe(activePool)

    await database.closeDatabase()
    expect(activePool?.ended).toBe(true)
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

    // drizzle's execute() wraps the mysql2 error in a DrizzleQueryError whose
    // message is the SQL; the ER_NO_SUCH_TABLE code lives on `cause`.
    executeImpl = async () => {
      throw new Error('Failed query: SELECT name, applied_at FROM __drizzle_migrations', {
        cause: Object.assign(new Error("Table 'guren.__drizzle_migrations' doesn't exist"), {
          code: 'ER_NO_SUCH_TABLE',
          errno: 1146,
        }),
      })
    }

    expect(await database.migrationStatus()).toEqual([
      { name: '20240101000000_init', applied: false, appliedAt: null },
    ])
  })

  it('surfaces a denied tracker read from db:status instead of calling every migration pending', async () => {
    const database = createMySqlDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'mysql://guren:hunter2@db.internal:33306/guren',
    })

    // ER_TABLEACCESS_DENIED_ERROR (1142): the tracker exists, this user just
    // cannot read it. Absorbing it reports applied migrations as pending.
    executeImpl = async () => {
      throw new Error('Failed query: SELECT name, applied_at FROM __drizzle_migrations', {
        cause: Object.assign(
          new Error("SELECT command denied to user 'guren'@'%' for table '__drizzle_migrations'"),
          { code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 },
        ),
      })
    }

    const error = await database.migrationStatus().then(
      () => null,
      (reason: unknown) => reason as Error,
    )

    expect(error?.message).toContain("SELECT command denied to user 'guren'@'%' for table '__drizzle_migrations'")
    expect(error?.message).not.toContain('hunter2')
  })

  it('throws when seeders folder is missing', async () => {
    const database = createMySqlDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'mysql://example',
    })

    await expect(database.seedDatabase()).rejects.toThrow('No seeders folder configured')
  })
})
