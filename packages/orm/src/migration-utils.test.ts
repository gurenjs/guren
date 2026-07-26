import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMigrationStatus, describeConnectionEndpoint, describeMigrationFailure, listLocalMigrations } from './migration-utils'
import { createSqliteDatabase } from './sqlite'

function writeDrizzleMigration(migrationsDir: string, name: string, sql: string): void {
  const folder = join(migrationsDir, name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'migration.sql'), sql)
}

describe('listLocalMigrations', () => {
  test('should return empty list when folder is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guren-migrations-'))
    try {
      expect(listLocalMigrations(join(dir, 'nope'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('should list migration folders sorted by name and ignore loose files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guren-migrations-'))
    try {
      writeDrizzleMigration(dir, '20260102000000_second', 'SELECT 1;')
      writeDrizzleMigration(dir, '20260101000000_first', 'SELECT 1;')
      writeFileSync(join(dir, '0001_loose.sql'), 'SELECT 1;')
      mkdirSync(join(dir, 'not-a-migration'))

      expect(listLocalMigrations(dir).map((entry) => entry.name)).toEqual([
        '20260101000000_first',
        '20260102000000_second',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildMigrationStatus', () => {
  const local = [{ name: '20260101000000_first' }, { name: '20260102000000_second' }]

  test('should mark nothing applied when tracker is empty', () => {
    const status = buildMigrationStatus(local, [])
    expect(status.every((row) => !row.applied)).toBe(true)
    expect(status.every((row) => row.appliedAt === null)).toBe(true)
  })

  test('should mark applied entries by tracker name membership', () => {
    const status = buildMigrationStatus(local, [
      { name: '20260101000000_first', appliedAt: '2026-01-03T00:00:00.000Z' },
    ])
    expect(status[0].applied).toBe(true)
    expect(status[0].appliedAt).toEqual(new Date('2026-01-03T00:00:00.000Z'))
    expect(status[1].applied).toBe(false)
  })

  test('should tolerate rows without applied_at', () => {
    const status = buildMigrationStatus(local, [{ name: '20260101000000_first', appliedAt: null }])
    expect(status[0].applied).toBe(true)
    expect(status[0].appliedAt).toBeNull()
  })
})

describe('createSqliteDatabase resetDatabase/migrationStatus', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'guren-sqlite-reset-'))
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('should report status, reset all tables, and allow re-migration', async () => {
    const migrationsDir = join(workDir, 'migrations')
    writeDrizzleMigration(
      migrationsDir,
      '20260101000000_create_widgets',
      'CREATE TABLE widgets (id integer primary key autoincrement, name text not null);',
    )

    const dbFile = join(workDir, 'test.db')
    const database = createSqliteDatabase({
      migrationsFolder: migrationsDir,
      filename: dbFile,
    })

    // Before migrating: folder visible, nothing applied
    const before = await database.migrationStatus()
    expect(before).toHaveLength(1)
    expect(before[0].name).toBe('20260101000000_create_widgets')
    expect(before[0].applied).toBe(false)

    await database.migrateDatabase()

    const after = await database.migrationStatus()
    expect(after[0].applied).toBe(true)
    expect(after[0].appliedAt).not.toBeNull()

    // Table exists and accepts writes
    const { Database } = await import('bun:sqlite')
    const raw = new Database(dbFile)
    raw.exec("INSERT INTO widgets (name) VALUES ('a')")
    expect((raw.query('SELECT count(*) as c FROM widgets').get() as { c: number }).c).toBe(1)

    await database.resetDatabase()

    const tables = raw
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
    expect(tables).toHaveLength(0)

    const reset = await database.migrationStatus()
    expect(reset[0].applied).toBe(false)

    // Re-migration works after reset
    await database.migrateDatabase()
    const remigrated = await database.migrationStatus()
    expect(remigrated[0].applied).toBe(true)
  })
})

describe('describeConnectionEndpoint', () => {
  test('should reduce a connection string to host and port', () => {
    expect(describeConnectionEndpoint('postgres://guren:guren@localhost:54322/guren')).toBe('localhost:54322')
  })

  test('should not leak credentials from the connection string', () => {
    const endpoint = describeConnectionEndpoint('mysql://root:sup3rs3cret@db.internal:33306/app')
    expect(endpoint).toBe('db.internal:33306')
    expect(endpoint).not.toContain('sup3rs3cret')
    expect(endpoint).not.toContain('root')
  })

  test('should omit the port when the connection string has none', () => {
    expect(describeConnectionEndpoint('postgres://guren@example.com/guren')).toBe('example.com')
  })

  test('should return undefined for values that are not URLs', () => {
    expect(describeConnectionEndpoint('./data/guren.db')).toBeUndefined()
  })
})

describe('describeMigrationFailure', () => {
  test('should report a connection failure instead of the query drizzle happened to be running', () => {
    // Shape produced by drizzle + postgres-js when the server is unreachable:
    // the outer message names the migrator's own bookkeeping statement and the
    // AggregateError cause carries the code but no message at all.
    const cause = new AggregateError([], '')
    Object.assign(cause, { code: 'ECONNREFUSED' })
    const error = new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"\nparams: ', { cause })

    const message = describeMigrationFailure(error, 'localhost:54322')

    expect(message).toContain('cannot connect to the database at localhost:54322')
    expect(message).toContain('ECONNREFUSED')
    expect(message).not.toContain('CREATE SCHEMA')
  })

  test('should describe a connection failure without an endpoint', () => {
    const error = new Error('Failed query: SELECT 1', { cause: Object.assign(new Error(''), { code: 'ENOTFOUND' }) })
    expect(describeMigrationFailure(error)).toContain('cannot connect to the database (ENOTFOUND)')
  })

  test('should keep the real SQL error when the database is reachable', () => {
    const error = new Error('Failed query: ALTER TABLE "posts" ADD COLUMN "slug" text NOT NULL', {
      cause: new Error('column "slug" of relation "posts" already exists'),
    })

    const message = describeMigrationFailure(error, 'localhost:54322')

    expect(message).toContain('ALTER TABLE "posts"')
    expect(message).toContain('column "slug" of relation "posts" already exists')
  })

  test('should keep the in-flight query when the connection drops mid-migration', () => {
    // ECONNRESET/EPIPE can hit halfway through a run, so which migration was
    // executing is the useful part — unlike a server that was never reached.
    const error = new Error('Failed query: ALTER TABLE "posts" ADD COLUMN "slug" text', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    })

    const message = describeMigrationFailure(error, 'localhost:54322')

    expect(message).toContain('ALTER TABLE "posts"')
    expect(message).toContain('ECONNRESET')
    expect(message).not.toContain('cannot connect')
  })

  test('should append a bare error code when no cause carries a message', () => {
    const error = new Error('Failed query: ALTER TABLE "posts" ADD COLUMN "slug" text', {
      cause: Object.assign(new Error(''), { code: 'EPIPE' }),
    })

    expect(describeMigrationFailure(error, 'localhost:54322')).toBe(
      'Failed query: ALTER TABLE "posts" ADD COLUMN "slug" text (EPIPE)',
    )
  })

  test('should surface a cause nested inside an AggregateError', () => {
    const error = new Error('outer', { cause: new AggregateError([Object.assign(new Error(''), { code: 'ECONNREFUSED' })], '') })
    expect(describeMigrationFailure(error, 'db:5432')).toContain('ECONNREFUSED')
  })

  test('should not loop forever on a self-referencing cause chain', () => {
    const error = new Error('boom') as Error & { cause?: unknown }
    error.cause = error
    expect(describeMigrationFailure(error)).toBe('boom')
  })

  test('should stringify non-Error rejections', () => {
    expect(describeMigrationFailure('plain string failure')).toBe('plain string failure')
  })
})
