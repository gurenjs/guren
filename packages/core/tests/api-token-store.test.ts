import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { jsonb, pgTable, text as pgText, timestamp } from 'drizzle-orm/pg-core'
import {
  DatabaseApiTokenStore,
  DrizzleAdapter,
  Model,
  createApiToken,
  tokenCan,
  verifyApiToken,
  type ORMAdapterAdvanced,
  type PlainObject,
  type WhereCondition,
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

const identityColumns = {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hashedToken: text('hashed_token').notNull().unique(),
  userId: text('user_id').notNull(),
  abilities: text('abilities', { mode: 'json' }).$type<string[]>().notNull(),
}

// The SQLite scaffold's timestamp shape: `text('created_at')` holding an ISO string.
const apiTokensIso = sqliteTable('api_tokens_iso', {
  ...identityColumns,
  lastUsedAt: text('last_used_at'),
  expiresAt: text('expires_at'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
})

// Integer columns with no drizzle mode: nothing maps a Date for them.
const apiTokensEpoch = sqliteTable('api_tokens_epoch', {
  ...identityColumns,
  lastUsedAt: integer('last_used_at'),
  expiresAt: integer('expires_at'),
  createdAt: integer('created_at').notNull(),
})

const pgIdentityColumns = {
  id: pgText('id').primaryKey(),
  name: pgText('name').notNull(),
  hashedToken: pgText('hashed_token').notNull().unique(),
  userId: pgText('user_id').notNull(),
  abilities: jsonb('abilities').$type<string[]>().notNull(),
}

// The guide's Postgres schema.
const pgApiTokens = pgTable('api_tokens', {
  ...pgIdentityColumns,
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

const pgApiTokensText = pgTable('api_tokens_text', {
  ...pgIdentityColumns,
  lastUsedAt: pgText('last_used_at'),
  expiresAt: pgText('expires_at'),
  createdAt: pgText('created_at').notNull(),
})

/** Records what the store hands the ORM, for a dialect no test database runs here. */
function capturingAdapter() {
  const writes: PlainObject[] = []
  const conditions: WhereCondition[] = []
  const adapter: ORMAdapterAdvanced = {
    async findMany() {
      return []
    },
    async findUnique() {
      return null
    },
    async create(_table, data) {
      writes.push(data)
      return data as never
    },
    async update(_table, _where, data) {
      writes.push(data)
      return data as never
    },
    async delete() {
      return 0
    },
    async deleteAdvanced(_table, deleteConditions) {
      conditions.push(...deleteConditions)
      return 0
    },
  }
  return { adapter, writes, conditions }
}

function simpleConditionValue(condition: WhereCondition | undefined): unknown {
  return condition?.type === 'simple' ? condition.value : undefined
}

describe('DatabaseApiTokenStore', () => {
  let sqlite: Database
  let store: DatabaseApiTokenStore

  beforeEach(() => {
    sqlite = new Database(':memory:')
    for (const [tableName, timestampType] of [
      ['api_tokens', 'integer'],
      ['api_tokens_text', 'integer'],
      ['api_tokens_iso', 'text'],
      ['api_tokens_epoch', 'integer'],
    ]) {
      sqlite.exec(`
        CREATE TABLE ${tableName} (
          id text primary key,
          name text not null,
          hashed_token text not null unique,
          user_id text not null,
          abilities text not null,
          last_used_at ${timestampType},
          expires_at ${timestampType},
          created_at ${timestampType} not null
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

  describe('timestamp columns', () => {
    const rawTimestamps = (table: string, id: string) =>
      sqlite.query(`SELECT created_at, expires_at, last_used_at FROM ${table} WHERE id = ?`).get(id) as {
        created_at: unknown
        expires_at: unknown
        last_used_at: unknown
      }

    test('passes Dates through to timestamp-mode columns', async () => {
      const { token } = await createApiToken(store, {
        name: 'Timestamp Mode',
        userId: 'user-1',
        expiresIn: 60_000,
      })

      const raw = rawTimestamps('api_tokens', token.id)
      expect(raw.created_at).toBe(token.createdAt.getTime())
      expect(raw.expires_at).toBe(token.expiresAt!.getTime())
    })

    test('writes ISO strings to text columns, the SQLite scaffold shape, and reads them back as Dates', async () => {
      const isoStore = new DatabaseApiTokenStore(apiTokensIso)

      const { plainTextToken, token } = await createApiToken(isoStore, {
        name: 'Text Columns',
        userId: 'user-1',
        expiresIn: 60_000,
      })

      const raw = rawTimestamps('api_tokens_iso', token.id)
      expect(raw.created_at).toBe(token.createdAt.toISOString())
      expect(raw.expires_at).toBe(token.expiresAt!.toISOString())
      expect(raw.last_used_at).toBeNull()

      const result = await verifyApiToken(plainTextToken, isoStore)
      expect(result).not.toBeNull()
      expect(result!.token.createdAt).toEqual(token.createdAt)
      expect(result!.token.expiresAt).toEqual(token.expiresAt)

      const [stored] = await isoStore.findByUserId('user-1')
      expect(stored!.lastUsedAt).toBeInstanceOf(Date)
      expect(rawTimestamps('api_tokens_iso', token.id).last_used_at).toBe(stored!.lastUsedAt!.toISOString())
    })

    test('deleteExpired prunes expired rows held in text columns', async () => {
      const isoStore = new DatabaseApiTokenStore(apiTokensIso)
      await createApiToken(isoStore, { name: 'Expired', userId: 'user-1', expiresIn: -1000 })
      await createApiToken(isoStore, { name: 'Live', userId: 'user-1', expiresIn: 60_000 })
      await createApiToken(isoStore, { name: 'Forever', userId: 'user-1' })

      await isoStore.deleteExpired()

      const names = (await isoStore.findByUserId('user-1')).map((token) => token.name).sort()
      expect(names).toEqual(['Forever', 'Live'])
    })

    test('writes epoch milliseconds to integer columns with no drizzle mode', async () => {
      const epochStore = new DatabaseApiTokenStore(apiTokensEpoch)

      const { plainTextToken, token } = await createApiToken(epochStore, {
        name: 'Epoch Columns',
        userId: 'user-1',
        expiresIn: 60_000,
      })

      const raw = rawTimestamps('api_tokens_epoch', token.id)
      expect(raw.created_at).toBe(token.createdAt.getTime())
      expect(raw.expires_at).toBe(token.expiresAt!.getTime())

      const result = await verifyApiToken(plainTextToken, epochStore)
      expect(result!.token.createdAt).toEqual(token.createdAt)
      expect(typeof rawTimestamps('api_tokens_epoch', token.id).last_used_at).toBe('number')

      await createApiToken(epochStore, { name: 'Expired', userId: 'user-2', expiresIn: -1000 })
      await epochStore.deleteExpired()
      expect(await epochStore.findByUserId('user-2')).toHaveLength(0)
    })

    test('hands Dates to Postgres timestamp columns and ISO strings to Postgres text columns', async () => {
      const { adapter, writes, conditions } = capturingAdapter()
      const previous = Model.getAdapter()
      Model.useAdapter(adapter)
      try {
        const usedAt = new Date('2026-01-02T03:04:05.678Z')
        const now = new Date('2026-02-03T04:05:06.789Z')

        const dateStore = new DatabaseApiTokenStore(pgApiTokens)
        const { token } = await createApiToken(dateStore, { name: 'A', userId: 'user-1', expiresIn: 60_000 })
        await dateStore.updateLastUsed(token.id, usedAt)
        await dateStore.deleteExpired(now)

        expect(writes[0]!.createdAt).toBe(token.createdAt)
        expect(writes[0]!.expiresAt).toBe(token.expiresAt)
        expect(writes[0]!.lastUsedAt).toBeNull()
        expect(writes[1]!.lastUsedAt).toBe(usedAt)
        expect(simpleConditionValue(conditions[0])).toBe(now)

        writes.length = 0
        conditions.length = 0

        const textStore = new DatabaseApiTokenStore(pgApiTokensText)
        const created = await createApiToken(textStore, { name: 'B', userId: 'user-1', expiresIn: 60_000 })
        await textStore.updateLastUsed(created.token.id, usedAt)
        await textStore.deleteExpired(now)

        expect(writes[0]!.createdAt).toBe(created.token.createdAt.toISOString())
        expect(writes[0]!.expiresAt).toBe(created.token.expiresAt!.toISOString())
        expect(writes[0]!.lastUsedAt).toBeNull()
        expect(writes[1]!.lastUsedAt).toBe(usedAt.toISOString())
        expect(simpleConditionValue(conditions[0])).toBe(now.toISOString())
      } finally {
        Model.useAdapter(previous)
      }
    })
  })
})
