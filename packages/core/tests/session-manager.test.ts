import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { SessionManager } from '@guren/server'
import { DrizzleAdapter } from '../src/index'
import { createSessionManager, registerDatabaseSessionDriver } from '../src/session-manager'
import { DatabaseSessionStore } from '../src/session-store'

const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
})

// The same table with a plain text column, which is what `dataMode: 'text'` is for.
const sessionsText = sqliteTable('sessions_text', {
  id: text('id').primaryKey(),
  data: text('data').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
})

describe('createSessionManager', () => {
  let sqlite: Database

  beforeEach(() => {
    sqlite = new Database(':memory:')
    for (const table of ['sessions', 'sessions_text']) {
      sqlite.exec(`CREATE TABLE ${table} (id text primary key, data text not null, expires_at integer not null);`)
    }
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
  })

  afterEach(() => {
    sqlite.close()
  })

  test('should resolve a database store that round-trips through the table', async () => {
    const manager = createSessionManager({
      default: 'database',
      stores: { database: { driver: 'database', table: sessions } },
    })

    const store = manager.store()
    expect(store).toBeInstanceOf(DatabaseSessionStore)

    await store.write('abc', { user: 1 }, 60)
    expect(await store.read('abc')).toEqual({ user: 1 })
    expect(sqlite.query('select count(*) as n from sessions').get()).toEqual({ n: 1 })
  })

  test('should pass driver options other than `table` to the store', async () => {
    const manager = createSessionManager({
      default: 'database',
      stores: { database: { driver: 'database', table: sessionsText, dataMode: 'text' } },
    })

    await manager.store().write('abc', { user: 1 }, 60)

    // `dataMode: 'text'` serializes for a column drizzle does not encode.
    expect(sqlite.query('select data from sessions_text').get()).toEqual({ data: '{"user":1}' })
    expect(await manager.store().read('abc')).toEqual({ user: 1 })
  })

  test('should keep the built-in drivers alongside database', () => {
    const manager = createSessionManager({ stores: { redis: { driver: 'redis', client: {} } } })

    expect(manager.getStoreNames()).toEqual(['memory', 'redis'])
    expect(manager.store('memory')).toBeDefined()
  })

  test('should sweep expired rows through pruneExpired', async () => {
    const manager = createSessionManager({
      default: 'database',
      stores: { database: { driver: 'database', table: sessions } },
    })
    await manager.store().write('live', {}, 60)
    sqlite.exec("INSERT INTO sessions (id, data, expires_at) VALUES ('dead', '{}', 1)")

    await manager.pruneExpired()

    expect(sqlite.query('select id from sessions').all()).toEqual([{ id: 'live' }])
  })

  test('should let a manager built elsewhere opt into the driver', () => {
    const manager = new SessionManager({
      default: 'database',
      stores: { database: { driver: 'database', table: sessions } },
    })

    expect(() => manager.store()).toThrow('Unknown session driver: database')
    registerDatabaseSessionDriver(manager)
    expect(manager.store()).toBeInstanceOf(DatabaseSessionStore)
  })
})

describe('the built declaration', () => {
  // The `database` driver type-checks in an app only if this augmentation
  // survives into core's bundled .d.ts; nothing else would notice its loss,
  // since core's own sources see the source file.
  test('should carry the SessionDrivers augmentation', () => {
    const declaration = join(import.meta.dir, '../dist/index.d.ts')
    if (!existsSync(declaration)) {
      throw new Error(`Expected ${declaration}; run \`bun run build core\` before this test.`)
    }

    const source = readFileSync(declaration, 'utf8')
    expect(source).toContain("declare module '@guren/server'")
    expect(source).toMatch(/interface SessionDrivers\s*\{\s*database:/)
  })
})
