import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Context } from 'hono'
import type { FindManyOptions, Model, ORMAdapter, PlainObject, WhereClause } from '@guren/orm'
import { AuthManager } from '../../src/auth/AuthManager'
import { AuthenticatableModel } from '../../src/auth/AuthenticatableModel'
import { SessionGuard } from '../../src/auth/SessionGuard'
import { ScryptHasher } from '../../src/auth/password/ScryptHasher'
import { NodeHasher } from '../../src/auth/password/NodeHasher'
import type { PasswordHasher } from '../../src/auth/password/PasswordHasher'
import { fakeSession } from '../support/session'
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
    expect(writes[0].where).toEqual({ id: 1, passwordHash: argonRow })
    expect(rows[0].passwordHash.startsWith('$scrypt$')).toBe(true)

    expect(await webGuard(manager).attempt({ email: 'a@example.com', password: 'secret' })).toBe(true)
    expect(await webGuard(manager).attempt({ email: 'a@example.com', password: 'wrong' })).toBe(false)
    expect(writes).toHaveLength(1)
  })

  test('the session a rehashing login opens outlives the rehash', async () => {
    const argonRow = await new ScryptHasher({ memoryCost: 1024, timeCost: 1 }).hash('secret')
    const rows: Row[] = [{ id: 1, email: 'a@example.com', passwordHash: argonRow }]
    const { model, writes } = fakeModel(rows)
    const manager = new AuthManager()
    manager.useModel(model)
    const session = fakeSession()
    const guard = () => manager.createGuard<Row>('web', { ctx: {} as Context, session, manager })

    expect(await guard().attempt({ email: 'a@example.com', password: 'secret' })).toBe(true)

    expect(writes).toHaveLength(1)
    expect(await guard().check()).toBe(true)
  })

  test('a rehash the model cannot write leaves the session bound to the stored hash', async () => {
    class Account extends AuthenticatableModel<PlainObject> {
      static override table = 'users'
    }
    const argonRow = await new ScryptHasher({ memoryCost: 1024, timeCost: 1 }).hash('secret')
    const rows: PlainObject[] = [{ id: 1, email: 'a@example.com', passwordHash: argonRow }]
    // Reads hand out copies, so the record the login fingerprints is not the stored row.
    Account.useAdapter({
      ...storeAdapter(rows),
      update: async () => {
        throw new Error('database is read-only')
      },
    } as unknown as ORMAdapter)
    const manager = new AuthManager()
    manager.useModel(Account as unknown as typeof Model<PlainObject>)
    const session = fakeSession()
    const guard = () => manager.createGuard<Row>('web', { ctx: {} as Context, session, manager })
    const warn = console.warn
    console.warn = () => {}
    try {
      expect(await guard().attempt({ email: 'a@example.com', password: 'secret' })).toBe(true)
    } finally {
      console.warn = warn
    }

    expect(rows[0].passwordHash).toBe(argonRow)
    expect(await guard().check()).toBe(true)
  })

  test('a password confirmation that rehashes keeps the session that asked', async () => {
    class Account extends AuthenticatableModel<PlainObject> {
      static override table = 'users'
    }
    const current = await new NodeHasher({ cost: 1024 }).hash('secret')
    const rows: PlainObject[] = [{ id: 1, email: 'a@example.com', passwordHash: current }]
    Account.useAdapter(storeAdapter(rows))
    const session = fakeSession()
    const guardOf = (manager: AuthManager) =>
      manager.createGuard<Row>('web', { ctx: {} as Context, session, manager })

    const before = new AuthManager({ hasher: new NodeHasher({ cost: 1024 }) })
    before.useModel(Account as unknown as typeof Model<PlainObject>)
    expect(await guardOf(before).attempt({ email: 'a@example.com', password: 'secret' })).toBe(true)
    expect(rows[0].passwordHash).toBe(current)

    // The same session after a deploy raised the cost: validate() rehashes.
    const after = new AuthManager({ hasher: new NodeHasher({ cost: 2048 }) })
    after.useModel(Account as unknown as typeof Model<PlainObject>)
    expect(await guardOf(after).validate({ email: 'a@example.com', password: 'secret' })).not.toBeNull()

    expect(rows[0].passwordHash).not.toBe(current)
    expect(await guardOf(after).check()).toBe(true)
  })

  test('a rehash leaves a password reset that landed after the row was read', async () => {
    class Account extends AuthenticatableModel<PlainObject> {
      static override table = 'users'
    }
    const verified = await new NodeHasher({ cost: 1024 }).hash('secret')
    const rows: PlainObject[] = [{ id: 1, email: 'a@example.com', passwordHash: verified }]
    Account.useAdapter(storeAdapter(rows))
    const manager = new AuthManager({ hasher: new NodeHasher({ cost: 2048 }) })
    manager.useModel(Account as unknown as typeof Model<PlainObject>)
    const provider = manager.getProvider<Row>('users')

    const read = await provider.retrieveByCredentials({ email: 'a@example.com' })
    const reset = await new NodeHasher({ cost: 2048 }).hash('new-secret')
    rows[0].passwordHash = reset
    await provider.rehashPasswordIfRequired?.(read!, { email: 'a@example.com', password: 'secret' })

    expect(rows[0].passwordHash).toBe(reset)
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

  test('a model pinned to its own hasher is not rewritten at the app default', async () => {
    const pinned = new NodeHasher({ cost: 2048 })
    class Pinned extends AuthenticatableModel<PlainObject> {
      static override table = 'users'
      protected static override passwordHasher: PasswordHasher | null = pinned
    }
    const stored = await pinned.hash('secret')
    const rows: PlainObject[] = [{ id: 1, email: 'a@example.com', passwordHash: stored }]
    Pinned.useAdapter(storeAdapter(rows))
    const manager = new AuthManager({ hasher: new NodeHasher({ cost: 1024 }) })
    manager.useModel(Pinned as unknown as typeof Model<PlainObject>)

    expect(await webGuard(manager).attempt({ email: 'a@example.com', password: 'secret' })).toBe(true)
    expect(await webGuard(manager).attempt({ email: 'a@example.com', password: 'secret' })).toBe(true)

    expect(rows[0].passwordHash).toBe(stored)
  })

  test('a rehash that cannot be written still logs the user in', async () => {
    const row = { id: 7, email: 'a@example.com', getAuthIdentifier: () => 7, getAuthPassword: () => null }
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
