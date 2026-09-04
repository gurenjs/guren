import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import {
  DatabaseApiTokenStore,
  DrizzleAdapter,
  createApiToken,
  tokenCan,
  verifyApiToken,
} from '../src/index'

const baseColumns = {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hashedToken: text('hashed_token').notNull().unique(),
  userId: text('user_id').notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}

const apiTokens = sqliteTable('api_tokens', {
  ...baseColumns,
  abilities: text('abilities', { mode: 'json' }).$type<string[]>().notNull(),
})

// Same shape but with a plain text abilities column (no drizzle json mode).
const apiTokensText = sqliteTable('api_tokens_text', {
  ...baseColumns,
  abilities: text('abilities').notNull(),
})

describe('DatabaseApiTokenStore', () => {
  let sqlite: Database
  let store: DatabaseApiTokenStore

  beforeEach(() => {
    sqlite = new Database(':memory:')
    for (const tableName of ['api_tokens', 'api_tokens_text']) {
      sqlite.exec(`
        CREATE TABLE ${tableName} (
          id text primary key,
          name text not null,
          hashed_token text not null unique,
          user_id text not null,
          abilities text not null,
          last_used_at integer,
          expires_at integer,
          created_at integer not null
        );
      `)
    }
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
    store = new DatabaseApiTokenStore(apiTokens)
  })

  afterEach(() => {
    sqlite.close()
  })

  test('round-trips a created token through verifyApiToken', async () => {
    const { plainTextToken, token } = await createApiToken(store, {
      name: 'Mobile App',
      userId: 'user-1',
      abilities: ['posts:read', 'posts:write'],
    })

    const result = await verifyApiToken(plainTextToken, store)

    expect(result).not.toBeNull()
    expect(result!.userId).toBe('user-1')
    expect(result!.abilities).toEqual(['posts:read', 'posts:write'])
    expect(result!.token.id).toBe(token.id)
    expect(result!.token.name).toBe('Mobile App')
    expect(result!.token.createdAt).toBeInstanceOf(Date)
  })

  test('rejects tampered and unknown tokens', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'App',
      userId: 'user-1',
    })

    expect(await verifyApiToken(`${plainTextToken}x`, store)).toBeNull()
    expect(await verifyApiToken('missing|deadbeef', store)).toBeNull()
  })

  test('rejects expired tokens and deleteExpired removes them', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'Short-lived',
      userId: 'user-1',
      expiresIn: -1000, // already expired
    })

    expect(await verifyApiToken(plainTextToken, store)).toBeNull()

    await store.deleteExpired()
    expect(await store.findByUserId('user-1')).toHaveLength(0)
  })

  test('keeps a null expiry as "never expires"', async () => {
    const { plainTextToken, token } = await createApiToken(store, {
      name: 'Forever',
      userId: 'user-1',
    })

    const stored = await store.findByHashedToken(token.hashedToken)

    expect(stored!.expiresAt).toBeNull()
    expect(await verifyApiToken(plainTextToken, store)).not.toBeNull()
  })

  test('does not authenticate a token whose stored expiry cannot be parsed', async () => {
    const { plainTextToken, token } = await createApiToken(store, {
      name: 'Corrupt Expiry',
      userId: 'user-1',
    })

    // Drizzle's timestamp mapper wraps the text in `new Date(...)`, so the store
    // reads an Invalid Date — which must not degrade to "no expiry", since
    // `verifyApiToken` skips its expiry check entirely on null.
    sqlite.exec(`UPDATE api_tokens SET expires_at = 'not-a-date' WHERE id = '${token.id}'`)

    // Pin the premise: INTEGER affinity cannot convert this, so the driver hands
    // the text back. A driver that coerced it would pass below for the wrong
    // reason.
    const raw = sqlite.query('SELECT expires_at FROM api_tokens WHERE id = ?').get(token.id) as {
      expires_at: unknown
    }
    expect(raw.expires_at).toBe('not-a-date')

    const stored = await store.findByHashedToken(token.hashedToken)
    expect(stored!.expiresAt).not.toBeNull()
    expect(stored!.expiresAt!.getTime()).toBe(0)

    expect(await verifyApiToken(plainTextToken, store)).toBeNull()
  })

  test('updates lastUsedAt on verification', async () => {
    const { plainTextToken, token } = await createApiToken(store, {
      name: 'App',
      userId: 'user-1',
    })
    expect(token.lastUsedAt).toBeNull()

    await verifyApiToken(plainTextToken, store)

    const [stored] = await store.findByUserId('user-1')
    expect(stored!.lastUsedAt).toBeInstanceOf(Date)
  })

  test('findByUserId, delete, and deleteForUser manage token lifecycles', async () => {
    const a = await createApiToken(store, { name: 'A', userId: 'user-1' })
    await createApiToken(store, { name: 'B', userId: 'user-1' })
    await createApiToken(store, { name: 'C', userId: 'user-2' })

    expect(await store.findByUserId('user-1')).toHaveLength(2)

    await store.delete(a.token.id)
    expect(await store.findByUserId('user-1')).toHaveLength(1)

    await store.deleteForUser('user-1')
    expect(await store.findByUserId('user-1')).toHaveLength(0)
    expect(await store.findByUserId('user-2')).toHaveLength(1)
  })

  test('supports plain text abilities columns via abilitiesMode', async () => {
    const textStore = new DatabaseApiTokenStore(apiTokensText, { abilitiesMode: 'text' })

    const { plainTextToken } = await createApiToken(textStore, {
      name: 'Text Mode',
      userId: 'user-1',
      abilities: ['read'],
    })

    const result = await verifyApiToken(plainTextToken, textStore)
    expect(result).not.toBeNull()
    expect(result!.abilities).toEqual(['read'])
  })

  test('degrades corrupt text abilities to an empty list instead of throwing', async () => {
    const textStore = new DatabaseApiTokenStore(apiTokensText, { abilitiesMode: 'text' })
    sqlite.exec(
      "INSERT INTO api_tokens_text (id, name, hashed_token, user_id, abilities, created_at) " +
        `VALUES ('t1', 'Broken', 'hash-1', 'user-1', 'not-json', ${Date.now()})`,
    )

    const token = await textStore.findByHashedToken('hash-1')

    expect(token).not.toBeNull()
    expect(token!.abilities).toEqual([])
  })

  test('degrades non-array abilities to an empty list instead of granting them', async () => {
    const textStore = new DatabaseApiTokenStore(apiTokensText, { abilitiesMode: 'text' })
    // Valid JSON, wrong shape: as a bare string `tokenCan` would run
    // `String.prototype.includes` and read '"*"' as the wildcard.
    sqlite.exec(
      'INSERT INTO api_tokens_text (id, name, hashed_token, user_id, abilities, created_at) ' +
        `VALUES ('t2', 'Wildcard String', 'hash-2', 'user-1', '"*"', ${Date.now()})`,
    )

    const token = await textStore.findByHashedToken('hash-2')

    expect(token!.abilities).toEqual([])
    expect(tokenCan(token!, 'posts:delete')).toBe(false)
  })
})
