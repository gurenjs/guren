import { describe, expect, it, mock, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

const destroyMock = mock(() => {})
const executeMock = mock(async (_query: unknown) => ({ rows: [] as Array<{ name: string | null }> }))
const drizzleMock = mock((config: Record<string, unknown>) => ({
  config,
  $client: { destroy: destroyMock },
  execute: executeMock,
}))
const migrateMock = mock(async () => {})

await mock.module('drizzle-orm/aws-data-api/pg', () => ({
  drizzle: drizzleMock,
}))

await mock.module('drizzle-orm/aws-data-api/pg/migrator', () => ({
  migrate: migrateMock,
}))

const { createAwsDataApiDatabase } = await import('../src/aws-data-api')

const CONNECTION = {
  database: () => 'appdb',
  resourceArn: () => 'arn:aws:rds:ap-northeast-1:123456789012:cluster:example',
  secretArn: () => 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:example',
}

function createMigrationsFolder(withMigrations: boolean): string {
  const migrationsFolder = mkdtempSync(join(tmpdir(), 'guren-orm-migrations-'))

  if (withMigrations) {
    const migrationDir = join(migrationsFolder, '20240101000000_init')
    mkdirSync(migrationDir, { recursive: true })
    writeFileSync(join(migrationDir, 'migration.sql'), '')
  }

  return migrationsFolder
}

describe('createAwsDataApiDatabase', () => {
  beforeEach(() => {
    delete process.env.DATABASE_NAME
    delete process.env.DATABASE_RESOURCE_ARN
    delete process.env.DATABASE_SECRET_ARN
  })

  it('runs migrations and returns a configured database', async () => {
    const database = createAwsDataApiDatabase({
      migrationsFolder: createMigrationsFolder(true),
      ...CONNECTION,
    })

    await database.migrateDatabase()
    expect(migrateMock).toHaveBeenCalled()

    const db = await database.getDatabase()
    expect(db).toMatchObject({
      config: {
        connection: {
          database: 'appdb',
          resourceArn: CONNECTION.resourceArn(),
          secretArn: CONNECTION.secretArn(),
        },
      },
    })
  })

  it('configures the Drizzle adapter', async () => {
    const database = createAwsDataApiDatabase({
      migrationsFolder: createMigrationsFolder(true),
      ...CONNECTION,
    })

    const originalConfigure = DrizzleAdapter.configure
    const configureSpy = mock(() => {})
    DrizzleAdapter.configure = configureSpy as typeof DrizzleAdapter.configure

    await database.configureOrm()
    expect(configureSpy).toHaveBeenCalled()

    DrizzleAdapter.configure = originalConfigure
  })

  it('does not migrate on getDatabase() by default', async () => {
    const database = createAwsDataApiDatabase({
      migrationsFolder: createMigrationsFolder(true),
      ...CONNECTION,
    })

    migrateMock.mockClear()
    await database.getDatabase()

    expect(migrateMock).not.toHaveBeenCalled()
  })

  it('migrates on getDatabase() when migrateOnStart is enabled', async () => {
    const database = createAwsDataApiDatabase({
      migrationsFolder: createMigrationsFolder(true),
      ...CONNECTION,
      migrateOnStart: true,
    })

    migrateMock.mockClear()
    await database.getDatabase()

    expect(migrateMock).toHaveBeenCalled()
  })

  it('skips migrations when drizzle metadata is missing', async () => {
    const database = createAwsDataApiDatabase({
      migrationsFolder: createMigrationsFolder(false),
      ...CONNECTION,
    })

    migrateMock.mockClear()
    await database.migrateDatabase()

    expect(migrateMock).not.toHaveBeenCalled()
  })

  it('throws when connection settings are missing', async () => {
    const database = createAwsDataApiDatabase({
      migrationsFolder: createMigrationsFolder(true),
    })

    await expect(database.getDatabase()).rejects.toThrow(
      'Missing AWS Data API connection settings: database (DATABASE_NAME), resourceArn (DATABASE_RESOURCE_ARN), secretArn (DATABASE_SECRET_ARN).',
    )
  })

  it('resolves connection settings from environment variables', async () => {
    process.env.DATABASE_NAME = 'envdb'
    process.env.DATABASE_RESOURCE_ARN = 'arn:aws:rds:env'
    process.env.DATABASE_SECRET_ARN = 'arn:aws:secretsmanager:env'

    const database = createAwsDataApiDatabase({
      migrationsFolder: createMigrationsFolder(false),
    })

    const db = await database.getDatabase()
    expect(db).toMatchObject({
      config: {
        connection: {
          database: 'envdb',
          resourceArn: 'arn:aws:rds:env',
          secretArn: 'arn:aws:secretsmanager:env',
        },
      },
    })
  })

  it('passes extra client options through to the driver', async () => {
    const database = createAwsDataApiDatabase({
      migrationsFolder: createMigrationsFolder(false),
      ...CONNECTION,
      clientOptions: { region: 'ap-northeast-1' },
    })

    const db = await database.getDatabase()
    expect(db).toMatchObject({
      config: { connection: { region: 'ap-northeast-1', database: 'appdb' } },
    })
  })

  it('throws when seeders folder is missing', async () => {
    const database = createAwsDataApiDatabase({
      migrationsFolder: createMigrationsFolder(true),
      ...CONNECTION,
    })

    await expect(database.seedDatabase()).rejects.toThrow('No seeders folder configured')
  })

  it('destroys the client on close', async () => {
    const database = createAwsDataApiDatabase({
      migrationsFolder: createMigrationsFolder(false),
      ...CONNECTION,
    })

    await database.getDatabase()
    destroyMock.mockClear()
    await database.closeDatabase()

    expect(destroyMock).toHaveBeenCalled()
  })

  it('reports per-migration applied state', async () => {
    const database = createAwsDataApiDatabase({
      migrationsFolder: createMigrationsFolder(true),
      ...CONNECTION,
    })

    executeMock.mockResolvedValueOnce({ rows: [{ name: '20240101000000_init' }] })
    const status = await database.migrationStatus()

    expect(status).toEqual([{ name: '20240101000000_init', applied: true, appliedAt: null }])
  })

  it('treats a missing tracker table as nothing applied', async () => {
    const database = createAwsDataApiDatabase({
      migrationsFolder: createMigrationsFolder(true),
      ...CONNECTION,
    })

    executeMock.mockRejectedValueOnce(new Error('relation "drizzle.__drizzle_migrations" does not exist'))
    const status = await database.migrationStatus()

    expect(status).toEqual([{ name: '20240101000000_init', applied: false, appliedAt: null }])
  })

  it('surfaces non-schema failures from migrationStatus', async () => {
    const database = createAwsDataApiDatabase({
      migrationsFolder: createMigrationsFolder(true),
      ...CONNECTION,
    })

    executeMock.mockRejectedValueOnce(new Error('AccessDeniedException: not authorized to perform rds-data:ExecuteStatement'))

    await expect(database.migrationStatus()).rejects.toThrow('AccessDeniedException')
  })
})
