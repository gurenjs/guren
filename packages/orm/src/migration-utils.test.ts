import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMigrationStatus, listLocalMigrations } from './migration-utils'
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
