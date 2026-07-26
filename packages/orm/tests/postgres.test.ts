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
    const database = createPostgresDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'postgres://example',
    })

    await database.migrateDatabase()
    expect(migrateMock).toHaveBeenCalled()

    const db = await database.getDatabase()
    expect(db).toMatchObject({ config: { client: expect.anything() } })
  })

  it('configures the Drizzle adapter', async () => {
    const database = createPostgresDatabase({
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
      migrationsFolder,
      connectionString: () => 'postgres://example',
    })

    migrateMock.mockClear()
    await database.migrateDatabase()

    expect(migrateMock).toHaveBeenCalled()
  })

  it('reports an unreachable server instead of the query drizzle was running', async () => {
    const database = createPostgresDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'postgres://guren:hunter2@db.internal:54322/guren',
    })

    // Shape drizzle + postgres-js produce when the server is not reachable: the
    // outer message names the migrator's own bookkeeping statement, and the
    // AggregateError cause carries the code with no message of its own.
    const cause = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' })
    migrateMock.mockImplementationOnce(async () => {
      throw new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"\nparams: ', { cause })
    })

    const error = await database.migrateDatabase().then(
      () => null,
      (reason: unknown) => reason as Error,
    )

    expect(error?.message).toBe(
      'Failed to run database migrations: cannot connect to the database at db.internal:54322 (ECONNREFUSED). Is it running and accepting connections?',
    )
    // The connection string's password must never reach the log.
    expect(error?.message).not.toContain('hunter2')
  })

  it('keeps the failing statement when the server is reachable', async () => {
    const database = createPostgresDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'postgres://guren:hunter2@db.internal:54322/guren',
    })

    migrateMock.mockImplementationOnce(async () => {
      throw new Error('Failed query: ALTER TABLE "posts" ADD COLUMN "slug" text', {
        cause: new Error('column "slug" of relation "posts" already exists'),
      })
    })

    const error = await database.migrateDatabase().then(
      () => null,
      (reason: unknown) => reason as Error,
    )

    expect(error?.message).toContain('ALTER TABLE "posts"')
    expect(error?.message).toContain('column "slug" of relation "posts" already exists')
  })

  it('throws when seeders folder is missing', async () => {
    const database = createPostgresDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'postgres://example',
    })

    await expect(database.seedDatabase()).rejects.toThrow('No seeders folder configured')
  })
})
