import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { createSqliteDatabase, type SqliteDatabase, type SqliteDatabaseOptions } from './sqlite'

type RunnableDatabase = { run(query: unknown): unknown }

function isOpen(db: unknown): boolean {
  try {
    ;(db as RunnableDatabase).run(sql`select 1`)
    return true
  } catch {
    return false
  }
}

/** Repeated calls from this module stand in for successive hot reloads. */
function reevaluate(options: SqliteDatabaseOptions, times: number): SqliteDatabase[] {
  const evaluations: SqliteDatabase[] = []
  for (let i = 0; i < times; i += 1) evaluations.push(createSqliteDatabase(options))
  return evaluations
}

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'guren-sqlite-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('createSqliteDatabase hot-reload teardown', () => {
  beforeEach(() => {
    process.execArgv.push('--hot')
  })

  afterEach(() => {
    process.execArgv.splice(process.execArgv.indexOf('--hot'), 1)
  })

  test('should close the handle a previous evaluation left open', async () => {
    const [previous, current] = reevaluate(
      { migrationsFolder: join(workDir, 'migrations'), filename: join(workDir, 'app.db') },
      2,
    )

    const previousDb = await previous.getDatabase()
    expect(isOpen(previousDb)).toBe(true)

    const currentDb = await current.getDatabase()

    expect(isOpen(previousDb)).toBe(false)
    expect(isOpen(currentDb)).toBe(true)

    await current.closeDatabase()
  })

  test('should replace a handle whose call moved to another line', async () => {
    // The key is the calling file, not the line, so an edit above the factory
    // still resolves to the same handle instead of orphaning the old one.
    const options = {
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    }

    const before = createSqliteDatabase(options)
    const beforeDb = await before.getDatabase()
    expect(isOpen(beforeDb)).toBe(true)

    const afterEdit = createSqliteDatabase(options)
    const afterEditDb = await afterEdit.getDatabase()

    expect(isOpen(beforeDb)).toBe(false)
    expect(isOpen(afterEditDb)).toBe(true)

    await afterEdit.closeDatabase()
  })

  test('should hand every claim a usable handle when reloads overlap', async () => {
    // Three claims land inside one teardown window. Without serializing them the
    // third closes the second's client mid-initialization, and the second
    // resolves to undefined — which would then be configured into the adapter.
    const [first, second, third] = reevaluate(
      { migrationsFolder: join(workDir, 'migrations'), filename: join(workDir, 'app.db') },
      3,
    )

    await first.getDatabase()
    const [secondDb, thirdDb] = await Promise.all([second.getDatabase(), third.getDatabase()])

    expect(secondDb).toBeDefined()
    expect(thirdDb).toBeDefined()
    expect(isOpen(thirdDb)).toBe(true)

    await third.closeDatabase()
  })

  test('should leave a handle for a different database file open', async () => {
    const opened: SqliteDatabase[] = []
    for (const name of ['first.db', 'second.db']) {
      opened.push(
        createSqliteDatabase({ migrationsFolder: join(workDir, 'migrations'), filename: join(workDir, name) }),
      )
    }

    const firstDb = await opened[0].getDatabase()
    const secondDb = await opened[1].getDatabase()

    expect(isOpen(firstDb)).toBe(true)
    expect(isOpen(secondDb)).toBe(true)

    await opened[0].closeDatabase()
    await opened[1].closeDatabase()
  })

  test('should not close a previous handle after an explicit closeDatabase', async () => {
    const [database] = reevaluate(
      { migrationsFolder: join(workDir, 'migrations'), filename: join(workDir, 'app.db') },
      1,
    )

    await database.getDatabase()
    await database.closeDatabase()

    // The slot is free, so reopening must not try to tear down the handle the
    // same factory already closed.
    const reopened = await database.getDatabase()
    expect(isOpen(reopened)).toBe(true)

    await database.closeDatabase()
  })
})

describe('createSqliteDatabase outside a hot-reloading runtime', () => {
  test('should never close another handle', async () => {
    // Same call site, same options — a reload would replace here, but without
    // `--hot` nothing may be torn down.
    const [first, second] = reevaluate(
      { migrationsFolder: join(workDir, 'migrations'), filename: join(workDir, 'app.db') },
      2,
    )

    const firstDb = await first.getDatabase()
    const secondDb = await second.getDatabase()

    expect(isOpen(firstDb)).toBe(true)
    expect(isOpen(secondDb)).toBe(true)

    await first.closeDatabase()
    await second.closeDatabase()
  })
})

describe('createSqliteDatabase resetDatabase', () => {
  test('should drop views as well as base tables', async () => {
    // sqlite_master lists views under their own type, so a reset that selects
    // only `type = 'table'` leaves them standing while still reporting success.
    // The next migration run then dies on `CREATE VIEW ... table v already
    // exists` — a reset that did not reset.
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    })

    const db = (await database.getDatabase()) as RunnableDatabase & { all(query: unknown): unknown[] }
    db.run(sql`CREATE TABLE t (id integer primary key, name text)`)
    db.run(sql`CREATE VIEW v AS SELECT id FROM t`)

    await database.resetDatabase()

    const remaining = db.all(sql`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`) as Array<{
      name: string
    }>
    expect(remaining.map((row) => row.name)).toEqual([])

    await database.closeDatabase()
  })

  test('should drop a user table whose name only looks internal', async () => {
    // `_` is a LIKE wildcard, so an unescaped `sqlite_%` filter also matches
    // names like `sqliteXtable` and mistakes them for SQLite's own tables.
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    })

    const db = (await database.getDatabase()) as RunnableDatabase & { all(query: unknown): unknown[] }
    db.run(sql`CREATE TABLE sqliteXtable (id integer primary key)`)

    await database.resetDatabase()

    expect(db.all(sql`SELECT name FROM main.sqlite_master`)).toEqual([])

    await database.closeDatabase()
  })

  test('should drop the migrated table when a temp table shares its name', async () => {
    // An unqualified DROP resolves against `temp` before `main`, so the temp
    // object absorbs the drop and the table migrations own survives the reset.
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    })

    const db = (await database.getDatabase()) as RunnableDatabase & { all(query: unknown): unknown[] }
    db.run(sql`CREATE TABLE t (id integer primary key)`)
    db.run(sql`CREATE TEMP TABLE t (id integer primary key)`)

    await database.resetDatabase()

    expect(db.all(sql`SELECT name FROM main.sqlite_master`)).toEqual([])

    await database.closeDatabase()
  })
})

describe('createSqliteDatabase concurrent getDatabase', () => {
  test('should open one handle when two callers race', async () => {
    // `getDatabase()` awaits the migration run before the connection, and with
    // no migrations to apply that await still yields — so both callers reach the
    // connection with nothing opened yet. Anything short of sharing one
    // in-flight promise opens a second client here, and `closeDatabase()` only
    // ever closes the latest one.
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    })

    const [first, second] = await Promise.all([database.getDatabase(), database.getDatabase()])
    expect(first).toBe(second)
    expect(isOpen(first)).toBe(true)

    // One close has to reach every client that was opened. It only can if there
    // was one: a second client is unreachable from here, and the factory holds
    // no reference that could close it either.
    await database.closeDatabase()
    expect(isOpen(first)).toBe(false)
  })

  test('should open one handle when two callers race a reopen', async () => {
    // The shared promise has to be dropped on close and only on close: keep it
    // and the reopen hands back the handle that was just closed, drop it too
    // eagerly and the two callers race their way to a second client again.
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    })

    await database.getDatabase()
    await database.closeDatabase()

    const [first, second] = await Promise.all([database.getDatabase(), database.getDatabase()])
    expect(first).toBe(second)
    expect(isOpen(first)).toBe(true)

    await database.closeDatabase()
  })
})

describe('createSqliteDatabase closeDatabase', () => {
  test('should close the underlying handle', async () => {
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    })

    const db = await database.getDatabase()
    await database.closeDatabase()

    expect(isOpen(db)).toBe(false)
  })
})

describe('createSqliteDatabase connection-URI filenames', () => {
  const POSTGRES_URI = 'postgres://guren:guren@localhost:54322/guren'
  let originalDatabaseUrl: string | undefined

  beforeEach(() => {
    originalDatabaseUrl = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
  })

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = originalDatabaseUrl
  })

  test('should reject a connection URI passed as the filename', async () => {
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: POSTGRES_URI,
    })

    await expect(database.getDatabase()).rejects.toThrow(/connection URI where it expects a file path/)
  })

  // The failure this guards is not the rejection but what used to happen instead:
  // the driver mkdir -p's the filename's directory, so an unguarded URI is created
  // as a `postgres:/guren:guren@localhost:54322` tree and migrated into silently.
  test('should create no directory tree for the rejected URI', async () => {
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: POSTGRES_URI,
    })

    await expect(database.getDatabase()).rejects.toThrow()

    expect(existsSync(resolve('postgres:'))).toBe(false)
  })

  // An app that never passes `filename` still inherits DATABASE_URL, which is how
  // a sqlite-backed Nightly Canary spent two weeks migrating a stray database.
  test('should reject a connection URI inherited from DATABASE_URL', async () => {
    process.env.DATABASE_URL = POSTGRES_URI

    const database = createSqliteDatabase({ migrationsFolder: join(workDir, 'migrations') })

    await expect(database.getDatabase()).rejects.toThrow(/from DATABASE_URL/)
    expect(existsSync(resolve('postgres:'))).toBe(false)
  })

  test.each([':memory:', '', 'file::memory:', 'file::memory:?cache=shared'])(
    'should accept %p, which carries a scheme but no authority',
    async (filename) => {
      const database = createSqliteDatabase({ migrationsFolder: join(workDir, 'migrations'), filename })

      const db = await database.getDatabase()
      expect(isOpen(db)).toBe(true)

      await database.closeDatabase()
    },
  )

  // `file:` never addresses a database server, so no form of it is a connection
  // string — including the authority-shaped one, which is sqlite's own spelling
  // of an absolute path and opens today.
  test('should accept file:// with an absolute path', async () => {
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: `file://${join(workDir, 'abs.db')}`,
    })

    const db = await database.getDatabase()
    expect(isOpen(db)).toBe(true)

    await database.closeDatabase()
  })

  // A one-letter scheme is always a Windows drive, never a registered scheme.
  test('should accept a Windows drive path whose separator got doubled', async () => {
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: 'C://db/app.db',
    })

    try {
      // Resolved against the cwd on a POSIX host, so this asserts the guard's
      // decision — reaching the open at all means the URI check let it through.
      const db = await database.getDatabase()
      expect(isOpen(db)).toBe(true)
      await database.closeDatabase()
    } finally {
      rmSync(resolve('C:'), { recursive: true, force: true })
    }
  })

  test('should accept file:local.db, which sqlite resolves to a real file', async () => {
    // sqlite resolves this URI against the cwd rather than workDir, so the file it
    // creates is cleaned up here rather than by the suite's workDir teardown.
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: 'file:local.db',
    })

    try {
      const db = await database.getDatabase()
      expect(isOpen(db)).toBe(true)
      await database.closeDatabase()
    } finally {
      rmSync(resolve('local.db'), { force: true })
    }
  })
})
