import { describe, expect, it } from 'bun:test'
import type { FindManyOptions, ORMAdapter, PlainObject, WhereClause } from '@guren/orm/Model'
import { AuthenticatableModel } from '../../src/auth/AuthenticatableModel'

function createAdapter(store: PlainObject[] = []): ORMAdapter {
  return {
    async findMany<TRecord extends PlainObject = PlainObject>(
      _table: unknown,
      _options?: FindManyOptions<TRecord>,
    ): Promise<TRecord[]> {
      return store.map((record) => ({ ...record })) as TRecord[]
    },
    async findUnique<TRecord extends PlainObject = PlainObject>(
      _table: unknown,
      _where: WhereClause<TRecord>,
    ): Promise<TRecord | null> {
      return null
    },
    async create<TRecord extends PlainObject = PlainObject>(table: unknown, data: PlainObject): Promise<TRecord> {
      store.push({ table, ...data })
      return { ...data } as TRecord
    },
    async update<TRecord extends PlainObject = PlainObject>(
      table: unknown,
      _where: WhereClause<TRecord>,
      data: PlainObject,
    ): Promise<TRecord> {
      store.push({ table, ...data })
      return { ...data } as TRecord
    },
  }
}

describe('AuthenticatableModel', () => {
  it('hashes the password field before persisting and removes the plain value', async () => {
    type UserRecord = { id?: number; email: string; passwordHash?: string }

    class User extends AuthenticatableModel<UserRecord> {
      static override table = 'users'
    }

    const captured: PlainObject[] = []
    User.useAdapter(createAdapter(captured))

    const created = await User.create({ email: 'demo@guren.dev', password: 'secret' })

    expect(created.passwordHash).toBeDefined()
    expect(typeof created.passwordHash).toBe('string')
    expect(created.passwordHash).not.toBe('secret')
    expect('password' in created).toBe(false)

    const persisted = captured[0]
    expect(persisted.passwordHash).toBeDefined()
    expect('password' in persisted).toBe(false)
  })

  it('supports custom password and hash column names', async () => {
    type MemberRecord = { id?: number; passwordDigest?: string }

    class Member extends AuthenticatableModel<MemberRecord> {
      static override table = 'members'
      static override passwordField = 'plainPassword'
      static override passwordHashField = 'passwordDigest'
    }

    const captured: PlainObject[] = []
    Member.useAdapter(createAdapter(captured))

    const created = await Member.create({ plainPassword: 'secret' })

    expect(created.passwordDigest).toBeDefined()
    expect('plainPassword' in created).toBe(false)

    const persisted = captured[0]
    expect(persisted.passwordDigest).toBeDefined()
    expect('plainPassword' in persisted).toBe(false)
  })
})
