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

  // The same file under two spellings is one database, so the second evaluation
  // has to take the first one's slot. The key is built from the path the driver
  // resolved, and a `file:` URI resolved as a relative name lands somewhere no
  // plain path ever will — so a reload that merely restyled the filename would
  // orphan the open handle instead of replacing it.
  test('should replace the handle when the filename changes to its file: URI', async () => {
    const filename = join(workDir, 'app.db')

    const before = createSqliteDatabase({ migrationsFolder: join(workDir, 'migrations'), filename })
    const beforeDb = await before.getDatabase()
    expect(isOpen(beforeDb)).toBe(true)

    const asUri = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: `file://${filename}`,
    })
    const asUriDb = await asUri.getDatabase()

    expect(isOpen(beforeDb)).toBe(false)
    expect(isOpen(asUriDb)).toBe(true)

    await asUri.closeDatabase()
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

  // The artifact both URI cases below assert the absence of: a directory named
  // after the scheme, created under the cwd. Cleared up front so a tree left by
  // a run from before this guard reds them once and not forever.
  const strayUriRoot = resolve('file:')

  beforeEach(() => {
    rmSync(strayUriRoot, { recursive: true, force: true })
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
    expect(existsSync(strayUriRoot)).toBe(false)
  })

  // Accepting the URI is only half of it: the driver `mkdir -p`s the database's
  // directory, and a URI handed to `resolve()` is taken as a *relative* name —
  // so the tree it prepares is `<cwd>/file:/…`. Both halves are asserted here
  // because each alone admits a wrong fix: the target directory does not exist
  // yet, so an implementation that just skips the mkdir for `file:` URIs fails
  // to open at all, and one that keeps concatenating leaves the stray tree
  // behind. Untracked, which is why no build, typecheck or test gate reported
  // it — and empty only where the host's sqlite parses the URI, which is the
  // half of this that is not portable and why the driver resolves it itself.
  test('should create the directory the URI names, not one named after the URI', async () => {
    const target = join(workDir, 'nested', 'deep.db')
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: `file://${target}`,
    })

    const db = await database.getDatabase()
    expect(isOpen(db)).toBe(true)
    await database.closeDatabase()

    expect(existsSync(target)).toBe(true)
    expect(existsSync(strayUriRoot)).toBe(false)
  })

  // `%20` is a space in the *directory* segment, so decoding is load-bearing on
  // the mkdir and not only on the open: prepare `deep%20dir` and sqlite, which
  // decodes, then opens into a directory that was never created.
  test('should percent-decode the URI before preparing its directory', async () => {
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: `file://${workDir}/deep%20dir/app.db`,
    })

    const db = await database.getDatabase()
    expect(isOpen(db)).toBe(true)
    await database.closeDatabase()

    expect(existsSync(join(workDir, 'deep dir', 'app.db'))).toBe(true)
    expect(existsSync(strayUriRoot)).toBe(false)
  })

  // The one authority sqlite accepts besides an empty one. Anything else it
  // rejects outright, which is why the driver prepares no directory for it.
  test('should accept file://localhost with an absolute path', async () => {
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: `file://localhost${join(workDir, 'nested', 'loopback.db')}`,
    })

    const db = await database.getDatabase()
    expect(isOpen(db)).toBe(true)
    await database.closeDatabase()

    expect(existsSync(join(workDir, 'nested', 'loopback.db'))).toBe(true)
    expect(existsSync(strayUriRoot)).toBe(false)
  })

  // Resolving the URI to a path is what makes it portable, and a path cannot
  // carry the parameters a URI can. Dropping them silently is the one outcome
  // worth refusing: `mode=ro` would come back as a writable database on a host
  // that used to honour it.
  test('should reject a file: URI carrying query parameters', async () => {
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: `file://${join(workDir, 'ro.db')}?mode=ro`,
    })

    await expect(database.getDatabase()).rejects.toThrow(/cannot honour the URI parameters/)
    expect(existsSync(strayUriRoot)).toBe(false)
  })

  // A fragment carries nothing, so it is dropped rather than refused — the same
  // thing sqlite does with it.
  test('should ignore a fragment on a file: URI', async () => {
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: `file://${join(workDir, 'frag.db')}#section`,
    })

    const db = await database.getDatabase()
    expect(isOpen(db)).toBe(true)
    await database.closeDatabase()

    expect(existsSync(join(workDir, 'frag.db'))).toBe(true)
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
    // The URI resolves against the cwd rather than workDir, so the file it
    // creates is cleaned up here rather than by the suite's workDir teardown.
    // That cwd-relative rule is sqlite's, not the URL parser's: `new URL()` reads
    // the same string as `/local.db`, so resolving these URIs through it would
    // point the mkdir at the filesystem root. Asserting *where* the file lands
    // is what makes this portable: a host whose sqlite does not parse URI
    // filenames opens one named literally `file:local.db` and reports success.
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: 'file:local.db',
    })

    try {
      const db = await database.getDatabase()
      expect(isOpen(db)).toBe(true)
      await database.closeDatabase()
      expect(existsSync(resolve('local.db'))).toBe(true)
    } finally {
      rmSync(resolve('local.db'), { force: true })
      // The name an implementation that resolved the URI as a relative path
      // would have opened. Cleaned so a red run leaves nothing in the tree.
      rmSync(resolve('file:local.db'), { force: true })
    }
  })
})

describe('createSqliteDatabase migrationStatus', () => {
  test('should surface a broken tracker table instead of calling every migration pending', async () => {
    // bun:sqlite reports every statement error as SQLITE_ERROR, so a tracker
    // whose columns drifted looks exactly like a missing one to a catch that
    // absorbs everything — and "nothing applied" is the answer that gets the
    // applied migrations re-run.
    const migrationsDir = join(workDir, 'migrations')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(migrationsDir, '20260101000000_init'), { recursive: true })
    writeFileSync(join(migrationsDir, '20260101000000_init', 'migration.sql'), 'SELECT 1;')

    const dbFile = join(workDir, 'app.db')
    const { Database } = await import('bun:sqlite')
    const raw = new Database(dbFile)
    raw.exec('CREATE TABLE __drizzle_migrations (id integer primary key, hash text not null)')
    raw.close()

    const database = createSqliteDatabase({ migrationsFolder: migrationsDir, filename: dbFile })
    try {
      await expect(database.migrationStatus()).rejects.toThrow(/no such column/)
    } finally {
      await database.closeDatabase()
    }
  })
})
