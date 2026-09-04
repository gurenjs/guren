import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

const drizzleMock = mock((config: Record<string, unknown>) => ({
  config,
}))
const migrateMock = mock(async () => {})
let unsafeImpl: (query: string) => Promise<unknown[]> = async () => []
const postgresMock = mock((_url: string, _options: Record<string, unknown>) => ({
  end: mock(async () => {}),
  unsafe: (query: string) => unsafeImpl(query),
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
  afterEach(() => {
    unsafeImpl = async () => []
  })

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

    // Shape drizzle + postgres-js produce when the server is unreachable: the outer
    // message names the migrator's bookkeeping statement, and the AggregateError
    // cause carries the code with no message of its own.
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
    // Canary: keeps the credential check alive if the assertion above is
    // ever loosened from toBe to toContain.
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

  it('reports an unreachable server from db:status instead of calling every migration pending', async () => {
    const migrationsFolder = createMigrationsFolder(true)
    const database = createPostgresDatabase({
      migrationsFolder,
      connectionString: () => 'postgres://guren:hunter2@db.internal:54322/guren',
    })

    // postgres-js reports an unreachable server as a message-less AggregateError,
    // which the tracker-table catch would otherwise read as "nothing applied".
    unsafeImpl = async () => {
      throw Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' })
    }

    const error = await database.migrationStatus().then(
      () => null,
      (reason: unknown) => reason as Error,
    )

    expect(error?.message).toBe(
      'cannot connect to the database at db.internal:54322 (ECONNREFUSED). Is it running and accepting connections?',
    )
  })

  it('still reports nothing applied when only the tracker table is missing', async () => {
    const migrationsFolder = createMigrationsFolder(true)
    const database = createPostgresDatabase({
      migrationsFolder,
      connectionString: () => 'postgres://guren:hunter2@db.internal:54322/guren',
    })

    unsafeImpl = async () => {
      throw Object.assign(new Error('relation "drizzle.__drizzle_migrations" does not exist'), { code: '42P01' })
    }

    const status = await database.migrationStatus()

    expect(status).toEqual([{ name: '20240101000000_init', applied: false, appliedAt: null }])
  })

  it('re-applies migrations after dropping the schema', async () => {
    // Mock-level coverage; the live equivalent is the sqlite test in
    // src/migration-utils.test.ts, which queries a table after a bare reset.
    const database = createPostgresDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'postgres://example',
    })

    await database.migrateDatabase()
    migrateMock.mockClear()

    await database.resetDatabase()

    expect(migrateMock).toHaveBeenCalledTimes(1)
  })

  it('describes an unreachable server when resetting rather than throwing a message-less error', async () => {
    const database = createPostgresDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'postgres://guren:hunter2@db.internal:54322/guren',
    })

    unsafeImpl = async () => {
      throw Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' })
    }

    const error = await database.resetDatabase().then(
      () => null,
      (reason: unknown) => reason as Error,
    )

    expect(error?.message).toBe(
      'cannot connect to the database at db.internal:54322 (ECONNREFUSED). Is it running and accepting connections?',
    )
  })

  it('describes a seeder failure instead of leaving the driver message on the cause', async () => {
    const seedersFolder = mkdtempSync(join(tmpdir(), 'guren-orm-seeders-'))
    writeFileSync(
      join(seedersFolder, 'BrokenSeeder.ts'),
      'export default async function run() {\n' +
        "  throw new Error('Failed query: INSERT INTO posts (title) VALUES ($1)', {\n" +
        "    cause: new Error('null value in column \"body\" violates not-null constraint'),\n" +
        '  })\n' +
        '}\n',
    )

    const database = createPostgresDatabase({
      migrationsFolder: createMigrationsFolder(true),
      seedersFolder,
      connectionString: () => 'postgres://guren:hunter2@db.internal:54322/guren',
    })

    const error = await database.seedDatabase().then(
      () => null,
      (reason: unknown) => reason as Error,
    )

    expect(error?.message).toContain('Failed to seed the database:')
    expect(error?.message).toContain('INSERT INTO posts')
    expect(error?.message).toContain('violates not-null constraint')
    expect(error?.message).not.toContain('hunter2')
  })

  it('throws when seeders folder is missing', async () => {
    const database = createPostgresDatabase({
      migrationsFolder: createMigrationsFolder(true),
      connectionString: () => 'postgres://example',
    })

    await expect(database.seedDatabase()).rejects.toThrow('No seeders folder configured')
  })
})
