import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Context } from 'hono'
import type { FindManyOptions, Model, ORMAdapter, PlainObject, WhereClause } from '@guren/orm'
import { AuthManager } from '../../src/auth/AuthManager'
import { AuthenticatableModel } from '../../src/auth/AuthenticatableModel'
import { SessionGuard } from '../../src/auth/SessionGuard'
import { ScryptHasher } from '../../src/auth/password/ScryptHasher'
import { NodeHasher } from '../../src/auth/password/NodeHasher'
import type { PasswordHasher } from '../../src/auth/password/PasswordHasher'
import type { Session } from '../../src/http/middleware'
import type { Guard, UserProvider } from '../../src/auth/types'

type Row = { id: number; email: string; passwordHash: string }

/** The three model statics `ModelUserProvider` reaches: lookup, credential lookup, and the rehash write. */
function fakeModel(rows: Row[]) {
  const writes: Array<{ where: PlainObject; data: PlainObject }> = []
  const model = {
    find: async (id: unknown) => rows.find((row) => row.id === id) ?? null,
    where: async (clause: PlainObject) => rows.filter((row) => row.email === clause.email),
    forceUpdate: async (where: PlainObject, data: PlainObject) => {
      writes.push({ where, data })
      const row = rows.find((candidate) => candidate.id === where.id)
      if (row) Object.assign(row, data)
      return row
    },
  }
  return { model: model as unknown as typeof Model<PlainObject>, writes }
}

/** Rows a real model reads and writes, so `preparePersistencePayload` runs for real. */
function storeAdapter(rows: PlainObject[]): ORMAdapter {
  const matches = (row: PlainObject, where: PlainObject) =>
    Object.entries(where).every(([key, value]) => row[key] === value)
  return {
    async findMany<T extends PlainObject = PlainObject>(_table: unknown, options?: FindManyOptions<T>): Promise<T[]> {
      const where = (options?.where ?? {}) as PlainObject
      return rows.filter((row) => matches(row, where)).map((row) => ({ ...row })) as T[]
    },
    async findUnique<T extends PlainObject = PlainObject>(_table: unknown, where: WhereClause<T>): Promise<T | null> {
      const row = rows.find((candidate) => matches(candidate, where as PlainObject))
      return (row ? { ...row } : null) as T | null
    },
    async update<T extends PlainObject = PlainObject>(
      _table: unknown,
      where: WhereClause<T>,
      data: PlainObject,
    ): Promise<T> {
      const row = rows.find((candidate) => matches(candidate, where as PlainObject))
      if (row) Object.assign(row, data)
      return { ...row } as T
    },
  } as unknown as ORMAdapter
}

function fakeSession(): Session {
  const data = new Map<string, unknown>()
  return {
    id: 'sid',
    isNew: false,
    get: (key: string) => data.get(key),
    set: (key: string, value: unknown) => data.set(key, value),
    forget: (key: string) => data.delete(key),
    has: (key: string) => data.has(key),
    all: () => Object.fromEntries(data),
    flush: () => data.clear(),
    regenerate: () => {},
    invalidate: () => {},
    flash: () => {},
    getFlash: () => undefined,
    reflash: () => {},
    keep: () => {},
  } as unknown as Session
}

function webGuard(manager: AuthManager): Guard<Row> {
  return manager.createGuard<Row>('web', { ctx: {} as Context, session: fakeSession(), manager })
}

describe('rehash on login', () => {
  const saved = process.env.GUREN_TESTING
  beforeEach(() => {
    process.env.GUREN_TESTING = '1'
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.GUREN_TESTING
    else process.env.GUREN_TESTING = saved
  })

  test('an Argon2id row migrates to scrypt on the first successful login under the default', async () => {
    const argonRow = await new ScryptHasher({ memoryCost: 1024, timeCost: 1 }).hash('secret')
    const rows: Row[] = [{ id: 1, email: 'a@example.com', passwordHash: argonRow }]
    const { model, writes } = fakeModel(rows)
    const manager = new AuthManager()
    manager.useModel(model)

    expect(await webGuard(manager).attempt({ email: 'a@example.com', password: 'secret' })).toBe(true)

    expect(writes).toHaveLength(1)
    expect(writes[0].where).toEqual({ id: 1 })
    expect(rows[0].passwordHash.startsWith('$scrypt$')).toBe(true)

    expect(await webGuard(manager).attempt({ email: 'a@example.com', password: 'secret' })).toBe(true)
    expect(await webGuard(manager).attempt({ email: 'a@example.com', password: 'wrong' })).toBe(false)
    expect(writes).toHaveLength(1)
  })

  test('a failed attempt never rehashes', async () => {
    const argonRow = await new ScryptHasher({ memoryCost: 1024, timeCost: 1 }).hash('secret')
    const rows: Row[] = [{ id: 1, email: 'a@example.com', passwordHash: argonRow }]
    const { model, writes } = fakeModel(rows)
    const manager = new AuthManager()
    manager.useModel(model)

    expect(await webGuard(manager).attempt({ email: 'a@example.com', password: 'wrong' })).toBe(false)
    expect(await webGuard(manager).attempt({ email: 'nobody@example.com', password: 'secret' })).toBe(false)

    expect(writes).toHaveLength(0)
    expect(rows[0].passwordHash).toBe(argonRow)
  })

  test("a scrypt row migrates to Argon2id under hasher: 'argon2'", async () => {
    const scryptRow = await new NodeHasher({ cost: 1024 }).hash('secret')
    const rows: Row[] = [{ id: 1, email: 'a@example.com', passwordHash: scryptRow }]
    const { model, writes } = fakeModel(rows)
    const manager = new AuthManager({ hasher: 'argon2' })
    manager.useModel(model)

    expect(await webGuard(manager).attempt({ email: 'a@example.com', password: 'secret' })).toBe(true)

    expect(writes).toHaveLength(1)
    expect(rows[0].passwordHash.startsWith('$argon2id$')).toBe(true)
    expect(await webGuard(manager).attempt({ email: 'a@example.com', password: 'secret' })).toBe(true)
  })

  test('a row already in the configured format is left alone', async () => {
    const scryptRow = await new NodeHasher({ cost: 1024 }).hash('secret')
    const rows: Row[] = [{ id: 1, email: 'a@example.com', passwordHash: scryptRow }]
    const { model, writes } = fakeModel(rows)
    const manager = new AuthManager()
    manager.useModel(model)

    expect(await webGuard(manager).attempt({ email: 'a@example.com', password: 'secret' })).toBe(true)
    expect(writes).toHaveLength(0)
  })

  test('a model that hashes in place stores the rehash without hashing it again', async () => {
    class InPlace extends AuthenticatableModel<PlainObject> {
      static override table = 'users'
      static override passwordField = 'passwordHash'
    }
    const argonRow = await new ScryptHasher({ memoryCost: 1024, timeCost: 1 }).hash('secret')
    const rows: PlainObject[] = [{ id: 1, email: 'a@example.com', passwordHash: argonRow }]
    InPlace.useAdapter(storeAdapter(rows))
    const manager = new AuthManager()
    manager.useModel(InPlace as unknown as typeof Model<PlainObject>)

    expect(await webGuard(manager).attempt({ email: 'a@example.com', password: 'secret' })).toBe(true)
    expect(String(rows[0].passwordHash).startsWith('$scrypt$')).toBe(true)

    // The written value is the hash, not a hash of the hash: hashing it twice
    // leaves a row nothing can log into again.
    expect(await webGuard(manager).attempt({ email: 'a@example.com', password: 'secret' })).toBe(true)
    expect(await webGuard(manager).attempt({ email: 'a@example.com', password: 'wrong' })).toBe(false)
  })

  test('a rehash that cannot be written still logs the user in', async () => {
    const row = { id: 7, email: 'a@example.com' }
    const provider: UserProvider<typeof row> = {
      retrieveById: async () => row,
      retrieveByCredentials: async () => row,
      validateCredentials: async () => true,
      getId: (user) => user.id,
      rehashPasswordIfRequired: async () => {
        throw new Error('database is read-only')
      },
    }
    const warnings: unknown[][] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args)
    try {
      const guard = new SessionGuard<typeof row>({ provider, session: fakeSession() })
      expect(await guard.attempt({ email: 'a@example.com', password: 'secret' })).toBe(true)
    } finally {
      console.warn = warn
    }

    expect(warnings).toHaveLength(1)
    expect(String(warnings[0][0])).toContain('user 7')
    expect(String(warnings[0][0])).not.toContain('secret')
  })

  test('a custom hasher without needsRehash() is never asked to rehash', async () => {
    const hashCalls: string[] = []
    const custom: PasswordHasher = {
      async hash(plain) {
        hashCalls.push(plain)
        return `$argon2id$custom:${plain}`
      },
      async verify(hashed, plain) {
        return hashed === `$argon2id$custom:${plain}`
      },
    }
    const rows: Row[] = [{ id: 1, email: 'a@example.com', passwordHash: '$argon2id$custom:secret' }]
    const { model, writes } = fakeModel(rows)
    const manager = new AuthManager({ hasher: custom })
    manager.useModel(model)

    expect(await webGuard(manager).attempt({ email: 'a@example.com', password: 'secret' })).toBe(true)
    expect(writes).toHaveLength(0)
    expect(hashCalls).toHaveLength(0)
  })
})
