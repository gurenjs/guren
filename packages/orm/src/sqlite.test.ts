import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
