import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALLOW_DESTRUCTIVE_ENV, DestructiveMigrationError } from '../src/migration-guard'
import { migrateAndReport } from '../src/migration-utils'
import { createSqliteDatabase } from '../src/sqlite'

let workDir: string
let migrationsDir: string
let dbFile: string

function writeMigration(name: string, sql: string): void {
  mkdirSync(join(migrationsDir, name), { recursive: true })
  writeFileSync(join(migrationsDir, name, 'migration.sql'), sql)
}

function countPosts(): number {
  const raw = new Database(dbFile)
  try {
    return (raw.query('SELECT count(*) AS c FROM posts').get() as { c: number }).c
  } finally {
    raw.close()
  }
}

async function captureWarnings(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  try {
    await run()
  } finally {
    console.warn = original
  }
  return lines
}

/** An app whose database already has `posts` with a row, through the real migrator. */
async function seededApp(): Promise<void> {
  writeMigration('20260101000000_create_posts', 'CREATE TABLE `posts` (`id` integer PRIMARY KEY, `title` text);')
  const first = createSqliteDatabase({ migrationsFolder: migrationsDir, filename: dbFile, destructiveMigrations: 'refuse' })
  await first.migrateDatabase()
  await first.closeDatabase()
  const raw = new Database(dbFile)
  raw.exec("INSERT INTO posts (title) VALUES ('kept')")
  raw.close()
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'guren-migration-guard-'))
  migrationsDir = join(workDir, 'migrations')
  dbFile = join(workDir, 'app.db')
  delete process.env[ALLOW_DESTRUCTIVE_ENV]
})

afterEach(() => {
  delete process.env[ALLOW_DESTRUCTIVE_ENV]
  rmSync(workDir, { recursive: true, force: true })
})

describe("destructiveMigrations: 'refuse' on a real SQLite database", () => {
  test('should refuse a pending DROP TABLE at boot, naming the file and line, and leave the rows', async () => {
    await seededApp()
    writeMigration('20260102000000_drop_posts', 'DROP TABLE `posts`;')

    const database = createSqliteDatabase({ migrationsFolder: migrationsDir, filename: dbFile, destructiveMigrations: 'refuse' })
    const failure = await database.configureOrm().then(() => undefined, (error: unknown) => error as Error)
    await database.closeDatabase()

    expect(failure?.message).toContain('20260102000000_drop_posts/migration.sql:1: drops table posts (drop-table)')
    expect(failure?.message).toContain('guren:allow-destructive')
    expect(countPosts()).toBe(1)
  })

  test('should apply a migration whose first line carries the marker', async () => {
    await seededApp()
    writeMigration('20260102000000_drop_posts', '-- guren:allow-destructive: archived elsewhere\nDROP TABLE `posts`;')

    const database = createSqliteDatabase({ migrationsFolder: migrationsDir, filename: dbFile, destructiveMigrations: 'refuse' })
    await database.migrateDatabase()
    const status = await database.migrationStatus()
    await database.closeDatabase()

    expect(status.every((row) => row.applied)).toBe(true)
    expect(() => countPosts()).toThrow(/no such table/)
  })

  test('should apply with a warning under the one-run override', async () => {
    await seededApp()
    writeMigration('20260102000000_drop_posts', 'DROP TABLE `posts`;')
    process.env[ALLOW_DESTRUCTIVE_ENV] = '1'

    const database = createSqliteDatabase({ migrationsFolder: migrationsDir, filename: dbFile, destructiveMigrations: 'refuse' })
    const warnings = await captureWarnings(() => database.migrateDatabase())
    await database.closeDatabase()

    expect(warnings.join('\n')).toContain(`${ALLOW_DESTRUCTIVE_ENV}=1 is set`)
    expect(() => countPosts()).toThrow(/no such table/)
  })

  test('should apply every migration of a fresh database, since each drop hits a table the run created', async () => {
    writeMigration('20260101000000_create_posts', 'CREATE TABLE `posts` (`id` integer PRIMARY KEY, `title` text);')
    writeMigration('20260102000000_drop_posts', 'DROP TABLE `posts`;')

    const database = createSqliteDatabase({ migrationsFolder: migrationsDir, filename: dbFile, destructiveMigrations: 'refuse' })
    const warnings = await captureWarnings(() => database.migrateDatabase())
    const status = await database.migrationStatus()
    await database.closeDatabase()

    expect(warnings.filter((line) => line.includes('destructive'))).toEqual([])
    expect(status.map((row) => row.applied)).toEqual([true, true])
  })

  test("should report each local migration's path on its status row", async () => {
    writeMigration('20260101000000_create_posts', 'CREATE TABLE `posts` (`id` integer PRIMARY KEY);')
    const database = createSqliteDatabase({ migrationsFolder: migrationsDir, filename: dbFile })
    const [row] = await database.migrationStatus()
    await database.closeDatabase()
    expect(row?.path).toBe(join(migrationsDir, '20260101000000_create_posts', 'migration.sql'))
  })
})

describe("destructiveMigrations: 'warn' (the default)", () => {
  test('should apply a pending DROP TABLE and say so', async () => {
    await seededApp()
    writeMigration('20260102000000_drop_posts', 'DROP TABLE `posts`;')

    const database = createSqliteDatabase({ migrationsFolder: migrationsDir, filename: dbFile })
    const warnings = await captureWarnings(() => database.migrateDatabase())
    await database.closeDatabase()

    expect(warnings.join('\n')).toContain('20260102000000_drop_posts/migration.sql:1: drops table posts')
    expect(() => countPosts()).toThrow(/no such table/)
  })
})

describe('migrateAndReport', () => {
  test('should judge every local migration, with no created-in-run exemption, when the tracker cannot be read', async () => {
    // The CREATE may be applied already, so it must not exempt the later DROP.
    writeMigration('20260101000000_create_posts', 'CREATE TABLE posts (id integer);')
    writeMigration('20260102000000_drop_posts', 'DROP TABLE posts;')
    let migrated = false

    const run = migrateAndReport(migrationsDir, {
      readApplied: () => {
        throw new Error('permission denied for table __drizzle_migrations')
      },
      migrate: () => {
        migrated = true
      },
      destructiveMigrations: 'refuse',
    })

    await expect(run).rejects.toThrow(/tracker could not be read[\s\S]*20260102000000_drop_posts/)
    expect(migrated).toBe(false)
  })

  test('should name the tracker read error in the refusal, rather than hide it behind the findings', async () => {
    writeMigration('20260102000000_drop_posts', 'DROP TABLE posts;')
    const readError = new Error('connect ECONNREFUSED 127.0.0.1:5432')

    const run = migrateAndReport(migrationsDir, {
      readApplied: () => {
        throw readError
      },
      migrate: () => {},
      destructiveMigrations: 'refuse',
    })

    const error = await run.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DestructiveMigrationError)
    expect((error as Error).message).toContain('ECONNREFUSED 127.0.0.1:5432')
    expect((error as Error).cause).toBe(readError)
  })

  test("should not judge a reset's re-apply, which runs without a tracker read", async () => {
    writeMigration('20260102000000_drop_other', 'DROP TABLE other;')
    let migrated = false
    await migrateAndReport(migrationsDir, { migrate: () => void (migrated = true), destructiveMigrations: 'refuse' })
    expect(migrated).toBe(true)
  })
})
