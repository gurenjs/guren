import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { DrizzleAdapter } from '../src/index'
import { DatabaseSessionStore } from '../src/session-store'

const baseColumns = {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
}

const sessions = sqliteTable('sessions', {
  ...baseColumns,
  data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
})

// Same shape but with a plain text data column (no drizzle json mode).
const sessionsText = sqliteTable('sessions_text', {
  ...baseColumns,
  data: text('data').notNull(),
})

describe('DatabaseSessionStore', () => {
  let sqlite: Database
  let store: DatabaseSessionStore

  beforeEach(() => {
    sqlite = new Database(':memory:')
    for (const tableName of ['sessions', 'sessions_text']) {
      sqlite.exec(`
        CREATE TABLE ${tableName} (
          id text primary key,
          data text not null,
          expires_at integer not null
        );
      `)
    }
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
    store = new DatabaseSessionStore(sessions)
  })

  afterEach(() => {
    sqlite.close()
  })

  test('should return undefined for a session that does not exist', async () => {
    expect(await store.read('missing')).toBeUndefined()
  })

  test('should round-trip session data through write and read', async () => {
    await store.write('abc', { userId: 7, flash: { new: {}, old: {} } }, 60)

    const data = await store.read('abc')

    expect(data).toEqual({ userId: 7, flash: { new: {}, old: {} } })
  })

  test('should overwrite existing session data on subsequent writes', async () => {
    await store.write('abc', { count: 1 }, 60)
    await store.write('abc', { count: 2 }, 60)

    expect(await store.read('abc')).toEqual({ count: 2 })

    const rows = sqlite.query("SELECT COUNT(*) as count FROM sessions").get() as { count: number }
    expect(rows.count).toBe(1)
  })

  test('should treat expired sessions as missing and delete the row', async () => {
    await store.write('abc', { userId: 7 }, -10)

    expect(await store.read('abc')).toBeUndefined()

    const rows = sqlite.query("SELECT COUNT(*) as count FROM sessions").get() as { count: number }
    expect(rows.count).toBe(0)
  })

  test('should destroy a session', async () => {
    await store.write('abc', { userId: 7 }, 60)
    await store.destroy('abc')

    expect(await store.read('abc')).toBeUndefined()
  })

  test('should treat repeated destroy calls as safe', async () => {
    await store.destroy('abc')
    await store.destroy('abc')
  })

  test('should delete only expired rows in deleteExpired', async () => {
    await store.write('live', { userId: 1 }, 3600)
    await store.write('dead', { userId: 2 }, -10)

    await store.deleteExpired()

    expect(await store.read('live')).toEqual({ userId: 1 })
    const rows = sqlite.query("SELECT COUNT(*) as count FROM sessions").get() as { count: number }
    expect(rows.count).toBe(1)
  })

  test('should support plain text data columns via dataMode text', async () => {
    const textStore = new DatabaseSessionStore(sessionsText, { dataMode: 'text' })

    await textStore.write('abc', { nested: { value: true } }, 60)

    expect(await textStore.read('abc')).toEqual({ nested: { value: true } })

    const row = sqlite.query("SELECT data FROM sessions_text WHERE id = 'abc'").get() as { data: string }
    expect(typeof row.data).toBe('string')
  })

  test('should return empty session data for a corrupt text payload', async () => {
    const textStore = new DatabaseSessionStore(sessionsText, { dataMode: 'text' })
    sqlite.exec(
      "INSERT INTO sessions_text (id, data, expires_at) VALUES ('bad', 'not-json', " +
        `${Date.now() + 60_000})`,
    )

    expect(await textStore.read('bad')).toEqual({})
  })
})
