import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

function writeMigration(name: string, statement: string): void {
  const folder = join(workDir, 'migrations', name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'migration.sql'), statement)
}

async function captureConsole(method: 'info' | 'warn', run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const original = console[method]
  console[method] = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  try {
    await run()
  } finally {
    console[method] = original
  }
  return lines
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

describe('createSqliteDatabase foreign keys', () => {
  type QueryableDatabase = RunnableDatabase & { get(query: unknown): unknown }

  function foreignKeysPragma(db: QueryableDatabase): number {
    return (db.get(sql`PRAGMA foreign_keys`) as { foreign_keys: number }).foreign_keys
  }

  function countComments(db: QueryableDatabase): number {
    return (db.get(sql`SELECT count(*) AS n FROM comments`) as { n: number }).n
  }

  test('should enforce ON DELETE cascade on a connection no reset has touched', async () => {
    // Enforcement is per connection and off by default. resetDatabase() and a
    // migration run both leave it on, so this opens with neither: the folder
    // stays empty, or the check would pass without the open path.
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    })

    const db = (await database.getDatabase()) as QueryableDatabase
    expect(foreignKeysPragma(db)).toBe(1)

    db.run(sql`CREATE TABLE posts (id integer primary key)`)
    db.run(sql`CREATE TABLE comments (id integer primary key, post_id integer REFERENCES posts(id) ON DELETE cascade)`)
    db.run(sql`INSERT INTO posts VALUES (1)`)
    db.run(sql`INSERT INTO comments VALUES (1, 1)`)
    db.run(sql`DELETE FROM posts WHERE id = 1`)

    expect(countComments(db)).toBe(0)

    await database.closeDatabase()
  })

  test('should keep child rows through a drizzle-kit table rebuild', async () => {
    // The migrator runs inside a transaction, where the migration's own
    // `PRAGMA foreign_keys=OFF` is a no-op, so the DROP TABLE of the rebuild
    // would cascade into comments unless the factory turns enforcement off.
    writeMigration(
      '20260101000000_init',
      [
        'CREATE TABLE `posts` (`id` integer PRIMARY KEY, `title` text);',
        'CREATE TABLE `comments` (`id` integer PRIMARY KEY, `post_id` integer REFERENCES `posts`(`id`) ON DELETE cascade);',
      ].join('\n--> statement-breakpoint\n'),
    )
    const options = {
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    }

    const first = createSqliteDatabase(options)
    const firstDb = (await first.getDatabase()) as QueryableDatabase
    firstDb.run(sql`INSERT INTO posts VALUES (1, 'hello')`)
    firstDb.run(sql`INSERT INTO comments VALUES (1, 1)`)
    await first.closeDatabase()

    writeMigration(
      '20260102000000_require_title',
      [
        'PRAGMA foreign_keys=OFF;',
        "CREATE TABLE `__new_posts` (`id` integer PRIMARY KEY, `title` text NOT NULL DEFAULT '');",
        'INSERT INTO `__new_posts`(`id`, `title`) SELECT `id`, `title` FROM `posts`;',
        'DROP TABLE `posts`;',
        'ALTER TABLE `__new_posts` RENAME TO `posts`;',
        'PRAGMA foreign_keys=ON;',
      ].join('--> statement-breakpoint\n'),
    )

    const second = createSqliteDatabase(options)
    const secondDb = (await second.getDatabase()) as QueryableDatabase

    expect(countComments(secondDb)).toBe(1)
    expect(foreignKeysPragma(secondDb)).toBe(1)

    await second.closeDatabase()
  })

  test('should warn when an applied migration leaves a row with no parent', async () => {
    // Enforcement is off while migrations run, so the orphan goes in unchecked.
    writeMigration(
      '20260101000000_init',
      [
        'CREATE TABLE `posts` (`id` integer PRIMARY KEY);',
        'CREATE TABLE `comments` (`id` integer PRIMARY KEY, `post_id` integer REFERENCES `posts`(`id`));',
        'INSERT INTO `comments` VALUES (1, 99);',
      ].join('\n--> statement-breakpoint\n'),
    )
    const options = {
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    }

    const first = createSqliteDatabase(options)
    const warnings = await captureConsole('warn', async () => void (await first.getDatabase()))
    await first.closeDatabase()
    expect(warnings.join('\n')).toContain('comments -> posts (1)')

    // Nothing applied on the next boot, so nothing is checked or repeated.
    const second = createSqliteDatabase(options)
    const reboot = await captureConsole('warn', async () => void (await second.getDatabase()))
    await second.closeDatabase()
    expect(reboot).toEqual([])
  })
})

describe('createSqliteDatabase migration reporting', () => {

  test('should name what a boot applied and say nothing on the next one', async () => {
    writeMigration('20260101000000_create_widgets', 'CREATE TABLE widgets (id integer primary key);')
    const options = {
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    }

    const first = createSqliteDatabase(options)
    const applied = await captureConsole('info', async () => void (await first.getDatabase()))
    await first.closeDatabase()
    expect(applied.join('\n')).toContain('20260101000000_create_widgets')

    const second = createSqliteDatabase(options)
    const reboot = await captureConsole('info', async () => void (await second.getDatabase()))
    await second.closeDatabase()
    // An up-to-date database boots on every restart; a line there is one nobody reads.
    expect(reboot).toEqual([])
  })

  test('should stay silent while resetDatabase re-applies what it just dropped', async () => {
    // A reset drops the tracker, so every migration reads as pending again.
    // The framework's own testing rules put resetDatabase() in `beforeEach`,
    // where a line per test naming every migration is the whole log's ruin.
    writeMigration('20260101000000_create_widgets', 'CREATE TABLE widgets (id integer primary key);')
    const database = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    })
    await database.getDatabase()

    const lines = await captureConsole('info', async () => void (await database.resetDatabase()))
    expect(lines).toEqual([])

    // The suppression is spent on that one run, not left on for the next boot.
    await database.closeDatabase()
    writeMigration('20260102000000_orphan_sessions', 'CREATE TABLE sessions (id text primary key);')
    const next = createSqliteDatabase({
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    })
    const applied = await captureConsole('info', async () => void (await next.getDatabase()))
    await next.closeDatabase()
    expect(applied.join('\n')).toContain('20260102000000_orphan_sessions')
  })

  test('should name only the migration that arrived after the database was current', async () => {
    // The accident this reports: a generator left a folder behind, nobody
    // applied it on purpose, and the next boot applies it.
    writeMigration('20260101000000_create_widgets', 'CREATE TABLE widgets (id integer primary key);')
    const options = {
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    }

    const first = createSqliteDatabase(options)
    await first.getDatabase()
    await first.closeDatabase()

    writeMigration('20260102000000_orphan_sessions', 'CREATE TABLE sessions (id text primary key);')
    const second = createSqliteDatabase(options)
    const applied = await captureConsole('info', async () => void (await second.getDatabase()))
    await second.closeDatabase()

    expect(applied).toHaveLength(1)
    expect(applied[0]).toContain('20260102000000_orphan_sessions')
    expect(applied[0]).not.toContain('20260101000000_create_widgets')
  })

  test('should name a migration whose folder was deleted after a boot applied it', async () => {
    writeMigration('20260101000000_create_widgets', 'CREATE TABLE widgets (id integer primary key);')
    writeMigration('20260102000000_create_sessions_table', 'CREATE TABLE sessions (id text primary key);')
    const options = {
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    }

    const scratch = createSqliteDatabase(options)
    await scratch.getDatabase()
    await scratch.closeDatabase()
    rmSync(join(workDir, 'migrations', '20260102000000_create_sessions_table'), { recursive: true })

    const inspect = createSqliteDatabase(options)
    const status = await inspect.migrationStatus()
    await inspect.closeDatabase()
    expect(status.map(({ name, orphaned }) => ({ name, orphaned: orphaned === true }))).toEqual([
      { name: '20260101000000_create_widgets', orphaned: false },
      { name: '20260102000000_create_sessions_table', orphaned: true },
    ])

    writeMigration('20260301000000_create_sessions', 'CREATE TABLE sessions (id text primary key);')
    const next = createSqliteDatabase(options)
    let warnings: string[]
    try {
      warnings = await captureConsole('warn', async () => {
        // The warning has to come first: this is the run that fails on the table left behind.
        await expect(next.getDatabase()).rejects.toThrow(/table sessions already exists/)
      })
    } finally {
      await next.closeDatabase()
    }
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('20260102000000_create_sessions_table')
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

  // The failure this guards is not the rejection but the driver's fallback: it
  // mkdir -p's the filename's directory, so an unguarded URI is created as a
  // `postgres:/guren:guren@localhost:54322` tree and migrated into silently.
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

  describe('in-memory filenames', () => {
    // What a Linux Bun, whose sqlite ignores URI filenames, opens for these forms.
    const strayMemoryFiles = ['file::memory:', 'file::memory:#section', 'file::memory:?cache=shared'].map((name) =>
      resolve(name),
    )

    beforeEach(() => {
      for (const file of strayMemoryFiles) rmSync(file, { force: true })
    })

    afterEach(() => {
      for (const file of strayMemoryFiles) rmSync(file, { force: true })
    })

    // The filename assertion is the one that fails on macOS too, whose sqlite
    // honours `file::memory:` and so opens memory whatever the driver passes.
    test.each([':memory:', '', 'file::memory:', 'file::memory:#section'])(
      'should open %p in memory without creating a file',
      async (filename) => {
        const database = createSqliteDatabase({ migrationsFolder: join(workDir, 'migrations'), filename })

        const db = await database.getDatabase()
        expect(isOpen(db)).toBe(true)
        expect((db as { $client: { filename: string } }).$client.filename).toBe(':memory:')

        await database.closeDatabase()
        for (const file of strayMemoryFiles) expect(existsSync(file)).toBe(false)
      },
    )

    test('should reject file::memory: carrying query parameters', async () => {
      const database = createSqliteDatabase({
        migrationsFolder: join(workDir, 'migrations'),
        filename: 'file::memory:?cache=shared',
      })

      await expect(database.getDatabase()).rejects.toThrow(/cannot honour the URI parameters/)
      for (const file of strayMemoryFiles) expect(existsSync(file)).toBe(false)
    })
  })

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

  // The driver `mkdir -p`s the database's directory, and a URI handed to
  // `resolve()` is taken as a *relative* name, so the tree it prepares is
  // `<cwd>/file:/…`. Both halves are asserted because each alone admits a wrong
  // fix: skipping the mkdir for `file:` URIs fails to open at all, and
  // concatenating leaves the stray (untracked, ungated) tree behind.
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
  // whose sqlite honours URI parameters.
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
    // The URI resolves against the cwd, not workDir, so cleanup happens here.
    // That rule is sqlite's, not the URL parser's: `new URL()` reads the same
    // string as `/local.db` and would point the mkdir at the filesystem root.
    // Asserting *where* the file lands is what makes this portable — a host
    // that does not parse URI filenames opens `file:local.db` and succeeds.
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
