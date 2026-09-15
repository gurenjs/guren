import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionContext } from './connection-context'
import { createSqliteDatabase } from './sqlite'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'guren-context-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function recordingDatabase(received: unknown[], filename: (context?: ConnectionContext) => string = () => ':memory:') {
  return createSqliteDatabase({
    migrationsFolder: join(workDir, 'migrations'),
    filename: (context) => {
      received.push(context)
      return filename(context)
    },
  })
}

describe('configureOrm(context) (RFC 0027 §2)', () => {
  test('hands the context to the connection resolver', async () => {
    const received: unknown[] = []
    const context = { env: { RFC27_DATABASE_FILE: ':memory:' } } as ConnectionContext
    const database = recordingDatabase(received)

    await database.configureOrm(context)
    await database.closeDatabase()

    expect(received).toEqual([context])
  })

  test('keeps the context for a resolution no configureOrm() call reaches', async () => {
    const received: unknown[] = []
    const context = { env: {} } as ConnectionContext
    const database = recordingDatabase(received)

    await database.configureOrm(context)
    await database.closeDatabase()
    await database.getDatabase()
    await database.closeDatabase()

    expect(received).toEqual([context, context])
  })

  test('reopens a handle opened before configureOrm() when the context names another database', async () => {
    const context = { env: { file: 'from-env.db' } } as ConnectionContext
    const database = recordingDatabase([], (given) =>
      join(workDir, (given?.env as { file?: string } | undefined)?.file ?? 'fallback.db'))

    await database.getDatabase()
    await database.configureOrm(context)
    await database.closeDatabase()

    expect(existsSync(join(workDir, 'fallback.db'))).toBe(true)
    expect(existsSync(join(workDir, 'from-env.db'))).toBe(true)
  })

  test('keeps a handle opened before configureOrm() when the context resolves to the same database', async () => {
    const received: unknown[] = []
    const database = recordingDatabase(received)

    await database.getDatabase()
    const first = await database.getDatabase()
    await database.configureOrm({ env: {} } as ConnectionContext)

    expect(await database.getDatabase()).toBe(first)
    await database.closeDatabase()
  })

  test('resolves with no context outside an application', async () => {
    const received: unknown[] = []
    const database = recordingDatabase(received)

    await database.getDatabase()
    await database.closeDatabase()

    expect(received).toEqual([undefined])
  })
})
