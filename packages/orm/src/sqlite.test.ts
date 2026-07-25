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

/**
 * A hot reload re-runs the same line of the same file, so repeating one call
 * site is what a reload looks like from inside the factory. It has to be a real
 * loop: JavaScriptCore reports the *caller* of a one-line wrapper, so routing
 * through a helper would produce two different call sites instead of one.
 */
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

  test('should leave a factory written elsewhere in the source untouched', async () => {
    // Two factories built side by side are distinct handles, not a reload —
    // even with identical options — so neither may close the other.
    const options = {
      migrationsFolder: join(workDir, 'migrations'),
      filename: join(workDir, 'app.db'),
    }

    const web = createSqliteDatabase(options)
    const jobs = createSqliteDatabase(options)

    const webDb = await web.getDatabase()
    const jobsDb = await jobs.getDatabase()

    expect(isOpen(webDb)).toBe(true)
    expect(isOpen(jobsDb)).toBe(true)

    await web.closeDatabase()
    await jobs.closeDatabase()
  })

  test('should leave one call site that opens different files alone', async () => {
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
