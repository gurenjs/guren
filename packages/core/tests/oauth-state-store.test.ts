import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { DrizzleAdapter } from '../src/index'
import { DatabaseOAuthStateStore } from '../src/oauth-state-store'

const oauthStates = sqliteTable('oauth_states', {
  stateHash: text('state_hash').primaryKey(),
  provider: text('provider').notNull(),
  redirectTo: text('redirect_to'),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
})

describe('DatabaseOAuthStateStore', () => {
  let sqlite: Database
  let store: DatabaseOAuthStateStore

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE oauth_states (
        state_hash text primary key,
        provider text not null,
        redirect_to text,
        expires_at integer not null
      );
    `)
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
    store = new DatabaseOAuthStateStore(oauthStates)
  })

  afterEach(() => {
    sqlite.close()
  })

  test('round-trips a stored state through find', async () => {
    const expiresAt = new Date(Date.now() + 60_000)
    await store.store('hash-1', {
      provider: 'github',
      redirectTo: '/dashboard',
      expiresAt,
    })

    const result = await store.find('hash-1')

    expect(result).not.toBeNull()
    expect(result!.provider).toBe('github')
    expect(result!.redirectTo).toBe('/dashboard')
    expect(result!.expiresAt).toBeInstanceOf(Date)
    expect(result!.expiresAt.getTime()).toBe(expiresAt.getTime())
  })

  test('returns null for an unknown state hash', async () => {
    expect(await store.find('missing')).toBeNull()
  })

  test('returns undefined redirectTo when omitted from the payload', async () => {
    await store.store('hash-2', {
      provider: 'google',
      expiresAt: new Date(Date.now() + 60_000),
    })

    const result = await store.find('hash-2')

    expect(result).not.toBeNull()
    expect(result!.redirectTo).toBeUndefined()
  })

  test('find returns null and deletes an expired state', async () => {
    await store.store('hash-3', {
      provider: 'github',
      expiresAt: new Date(Date.now() - 1000),
    })

    expect(await store.find('hash-3')).toBeNull()

    const row = sqlite.query('SELECT * FROM oauth_states WHERE state_hash = ?').get('hash-3')
    expect(row).toBeNull()
  })

  test('delete removes the row', async () => {
    await store.store('hash-4', {
      provider: 'github',
      expiresAt: new Date(Date.now() + 60_000),
    })

    await store.delete('hash-4')

    expect(await store.find('hash-4')).toBeNull()
  })

  test('consume returns the payload and removes the row', async () => {
    const expiresAt = new Date(Date.now() + 60_000)
    await store.store('hash-consume', {
      provider: 'github',
      redirectTo: '/dashboard',
      expiresAt,
    })

    const result = await store.consume('hash-consume')

    expect(result).not.toBeNull()
    expect(result!.provider).toBe('github')
    expect(result!.redirectTo).toBe('/dashboard')
    expect(result!.expiresAt.getTime()).toBe(expiresAt.getTime())

    expect(await store.consume('hash-consume')).toBeNull()
    expect(await store.find('hash-consume')).toBeNull()
  })

  test('consume returns null for an unknown state hash', async () => {
    expect(await store.consume('missing')).toBeNull()
  })

  test('consume returns null and deletes an expired state', async () => {
    await store.store('hash-consume-expired', {
      provider: 'github',
      expiresAt: new Date(Date.now() - 1000),
    })

    expect(await store.consume('hash-consume-expired')).toBeNull()

    const row = sqlite
      .query('SELECT * FROM oauth_states WHERE state_hash = ?')
      .get('hash-consume-expired')
    expect(row).toBeNull()
  })

  test('concurrent consume hands the payload to exactly one caller', async () => {
    await store.store('hash-race', {
      provider: 'github',
      redirectTo: '/dashboard',
      expiresAt: new Date(Date.now() + 60_000),
    })

    const results = await Promise.all([
      store.consume('hash-race'),
      store.consume('hash-race'),
      store.consume('hash-race'),
    ])

    const winners = results.filter((r) => r !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]!.provider).toBe('github')
  })

  test('deleteExpired removes only expired states', async () => {
    await store.store('expired', {
      provider: 'github',
      expiresAt: new Date(Date.now() - 1000),
    })
    await store.store('live', {
      provider: 'github',
      expiresAt: new Date(Date.now() + 60_000),
    })

    await store.deleteExpired()

    const expiredRow = sqlite
      .query('SELECT * FROM oauth_states WHERE state_hash = ?')
      .get('expired')
    expect(expiredRow).toBeNull()

    const liveRow = sqlite.query('SELECT * FROM oauth_states WHERE state_hash = ?').get('live')
    expect(liveRow).not.toBeNull()
  })
})
