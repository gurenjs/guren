import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { buildMigrationStatus, describeConnectionEndpoint, describeDatabaseFailure, listLocalMigrations } from './migration-utils'
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

  test('should report status, clear table contents, and leave migrations applied', async () => {
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

    // The reset dropped the table and migrated it back: the schema is there,
    // the rows are gone.
    const tables = raw
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name = 'widgets'")
      .all() as Array<{ name: string }>
    expect(tables).toHaveLength(1)
    expect((raw.query('SELECT count(*) as c FROM widgets').get() as { c: number }).c).toBe(0)

    const reset = await database.migrationStatus()
    expect(reset[0].applied).toBe(true)

    // The documented reset-then-migrate pattern still holds: the second run
    // sees an up-to-date tracker and no-ops rather than re-applying.
    await database.migrateDatabase()
    const remigrated = await database.migrationStatus()
    expect(remigrated).toHaveLength(1)
    expect(remigrated[0].applied).toBe(true)
  })

  test('should leave tables queryable without an explicit migrateDatabase() call', async () => {
    // The issue this test pins: `resetDatabase()` reads as self-sufficient, and
    // a caller that trusts the name used to meet "no such table" inside the
    // first query of the first test — far from the reset that caused it.
    const migrationsDir = join(workDir, 'migrations')
    writeDrizzleMigration(
      migrationsDir,
      '20260101000000_create_widgets',
      'CREATE TABLE widgets (id integer primary key autoincrement, name text not null);',
    )

    const database = createSqliteDatabase({
      migrationsFolder: migrationsDir,
      filename: join(workDir, 'test.db'),
    })

    // The handle is taken before the reset, so nothing re-migrates on the way
    // to the query — `getDatabase()` awaits the migration run, which would hide
    // the very gap this test covers.
    const db = (await database.getDatabase()) as { run(query: unknown): unknown; all(query: unknown): unknown[] }
    db.run(sql`INSERT INTO widgets (name) VALUES ('gear')`)

    await database.resetDatabase()

    expect(db.all(sql`SELECT name FROM widgets`)).toEqual([])
    db.run(sql`INSERT INTO widgets (name) VALUES ('cog')`)
    expect(db.all(sql`SELECT name FROM widgets`)).toEqual([{ name: 'cog' }])

    await database.closeDatabase()
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

describe('describeDatabaseFailure', () => {
  test('should report a connection failure instead of the query drizzle happened to be running', () => {
    // Shape produced by drizzle + postgres-js when the server is unreachable:
    // the outer message names the migrator's own bookkeeping statement and the
    // AggregateError cause carries the code but no message at all.
    const cause = new AggregateError([], '')
    Object.assign(cause, { code: 'ECONNREFUSED' })
    const error = new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"\nparams: ', { cause })

    const message = describeDatabaseFailure(error, 'localhost:54322')

    expect(message).toContain('cannot connect to the database at localhost:54322')
    expect(message).toContain('ECONNREFUSED')
    expect(message).not.toContain('CREATE SCHEMA')
  })

  test('should describe a connection failure without an endpoint', () => {
    const error = new Error('Failed query: SELECT 1', { cause: Object.assign(new Error(''), { code: 'ENOTFOUND' }) })
    expect(describeDatabaseFailure(error)).toContain('cannot connect to the database (ENOTFOUND)')
  })

  test('should keep the real SQL error when the database is reachable', () => {
    const error = new Error('Failed query: ALTER TABLE "posts" ADD COLUMN "slug" text NOT NULL', {
      cause: new Error('column "slug" of relation "posts" already exists'),
    })

    const message = describeDatabaseFailure(error, 'localhost:54322')

    expect(message).toContain('ALTER TABLE "posts"')
    expect(message).toContain('column "slug" of relation "posts" already exists')
  })

  test('should treat a mysql2 connect timeout as a connection failure', () => {
    // mysql2 reports a connect timeout as ETIMEDOUT with syscall 'connect';
    // a read that times out mid-query does not carry that syscall.
    const cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', syscall: 'connect' })
    const error = new Error('Failed query: CREATE TABLE `__drizzle_migrations`', { cause })

    const message = describeDatabaseFailure(error, 'db.internal:33306')

    expect(message).toBe(
      'cannot connect to the database at db.internal:33306 (ETIMEDOUT). Is it running and accepting connections?',
    )
  })

  test('should keep the in-flight query when a read times out mid-migration', () => {
    const cause = Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT', syscall: 'read' })
    const error = new Error('Failed query: ALTER TABLE `posts` ADD COLUMN `slug` text', { cause })

    const message = describeDatabaseFailure(error, 'db.internal:33306')

    expect(message).toContain('ALTER TABLE `posts`')
    expect(message).not.toContain('cannot connect')
  })

  test('should keep the in-flight query when the connection drops mid-migration', () => {
    // ECONNRESET/EPIPE can hit halfway through a run, so which migration was
    // executing is the useful part — unlike a server that was never reached.
    const error = new Error('Failed query: ALTER TABLE "posts" ADD COLUMN "slug" text', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    })

    const message = describeDatabaseFailure(error, 'localhost:54322')

    expect(message).toContain('ALTER TABLE "posts"')
    expect(message).toContain('ECONNRESET')
    expect(message).not.toContain('cannot connect')
  })

  test('should append a bare error code when no cause carries a message', () => {
    const error = new Error('Failed query: ALTER TABLE "posts" ADD COLUMN "slug" text', {
      cause: Object.assign(new Error(''), { code: 'EPIPE' }),
    })

    expect(describeDatabaseFailure(error, 'localhost:54322')).toBe(
      'Failed query: ALTER TABLE "posts" ADD COLUMN "slug" text (EPIPE)',
    )
  })

  test('should append the driver code rather than a SQLSTATE on an outer frame', () => {
    const error = Object.assign(new Error('Failed query: SELECT 1'), { code: '42P06' })
    error.cause = Object.assign(new Error(''), { code: 'EPIPE' })

    expect(describeDatabaseFailure(error)).toBe('Failed query: SELECT 1 (EPIPE)')
  })

  test('should surface a cause nested inside an AggregateError', () => {
    const error = new Error('outer', { cause: new AggregateError([Object.assign(new Error(''), { code: 'ECONNREFUSED' })], '') })
    expect(describeDatabaseFailure(error, 'db:5432')).toContain('ECONNREFUSED')
  })

  test('should not loop forever on a self-referencing cause chain', () => {
    const error = new Error('boom') as Error & { cause?: unknown }
    error.cause = error
    expect(describeDatabaseFailure(error)).toBe('boom')
  })

  test('should stringify non-Error rejections', () => {
    expect(describeDatabaseFailure('plain string failure')).toBe('plain string failure')
  })
})
