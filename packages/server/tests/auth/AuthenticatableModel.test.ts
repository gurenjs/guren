import { describe, expect, it } from 'bun:test'
import { MassAssignmentException, defineModel } from '@guren/orm'
import type { FindManyOptions, Model, ORMAdapter, PlainObject, WhereClause } from '@guren/orm'
import { AuthenticatableModel } from '../../src/auth/AuthenticatableModel'
import { ModelUserProvider } from '../../src/auth/providers/ModelUserProvider'

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
      // Direct extension: createType no longer widens to PlainObject, so declare the payload.
      declare static readonly createType: Partial<UserRecord> & { password?: string }
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

  it('hashes the password on query-builder bulk updates', async () => {
    type UserRecord = { id?: number; email: string; passwordHash?: string }

    class User extends AuthenticatableModel<UserRecord> {
      static override table = 'users'
    }

    const captured: PlainObject[] = []
    User.useAdapter(createAdapter(captured))

    await User.where('email', 'demo@guren.dev').update({ password: 'secret' })

    const persisted = captured[0]
    expect(persisted.passwordHash).toBeDefined()
    expect(persisted.passwordHash).not.toBe('secret')
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

describe('as a defineModel base', () => {
  // Scaffolded apps reach the hashing pipeline through the subclass defineModel() synthesizes;
  // every other check on that path is a type check, so only this catches signups storing plaintext.
  const usersTable = {
    $inferSelect: {} as { id: number; email: string; passwordHash: string },
    $inferInsert: {} as { id?: number; email: string; passwordHash: string },
  }

  it('hashes the password field for a model built with defineModel', async () => {
    class User extends defineModel(usersTable, {
      base: AuthenticatableModel,
      optionalOnCreate: ['passwordHash'],
      requireOnCreate: ['password'],
    }) {}

    const captured: PlainObject[] = []
    User.useAdapter(createAdapter(captured))

    const created = await User.create({ email: 'demo@guren.dev', password: 'secret' })

    expect(created.passwordHash).toBeDefined()
    expect(created.passwordHash).not.toBe('secret')
    expect('password' in created).toBe(false)
    expect(captured[0]).toHaveProperty('passwordHash')
    expect(captured[0]).not.toHaveProperty('password')
  })
})

describe('passwordless accounts (OAuth)', () => {
  it('persists no password hash when no password is supplied', async () => {
    type UserRecord = { id?: number; email: string; passwordHash?: string | null }

    class User extends AuthenticatableModel<UserRecord> {
      static override table = 'users'
      declare static readonly createType: Partial<UserRecord> & { password?: string }
    }

    const captured: PlainObject[] = []
    User.useAdapter(createAdapter(captured))

    await User.create({ email: 'oauth@guren.dev' })

    expect(captured[0]).not.toHaveProperty('passwordHash')
    expect(captured[0]).not.toHaveProperty('password')
  })
})

describe('credential columns are denied from mass assignment', () => {
  type UserRecord = { id?: number; email?: string; passwordHash?: string; rememberToken?: string }

  it('rejects a mass-assigned password hash on create, update, and bulk update', async () => {
    class User extends AuthenticatableModel<UserRecord> {
      static override table = 'users'
    }
    const captured: PlainObject[] = []
    User.useAdapter(createAdapter(captured))

    await expect(User.create({ email: 'a@x.com', passwordHash: 'attacker' } as never)).rejects.toThrow(
      MassAssignmentException,
    )
    await expect(User.update({ id: 1 }, { passwordHash: 'attacker' } as never)).rejects.toThrow(
      MassAssignmentException,
    )
    await expect(User.where('id', 1).update({ passwordHash: 'attacker' })).rejects.toThrow(
      MassAssignmentException,
    )
    expect(captured).toHaveLength(0)
  })

  it('rejects the hash even when the model lists it in fillable', async () => {
    class User extends AuthenticatableModel<UserRecord> {
      static override table = 'users'
      static override fillable = ['email', 'passwordHash']
    }
    User.useAdapter(createAdapter([]))

    try {
      await User.create({ email: 'a@x.com', passwordHash: 'precomputed' } as never)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(MassAssignmentException)
      expect((error as MassAssignmentException).reason).toBe('denied')
    }
  })

  it('rejects a mass-assigned remember token', async () => {
    class User extends AuthenticatableModel<UserRecord> {
      static override table = 'users'
    }
    User.useAdapter(createAdapter([]))

    await expect(User.create({ email: 'a@x.com', rememberToken: 'forged' } as never)).rejects.toThrow(
      MassAssignmentException,
    )
  })

  it('follows renamed hash and remember-token columns', async () => {
    class Member extends AuthenticatableModel<PlainObject> {
      static override table = 'members'
      static override passwordHashField = 'passwordDigest'
      static override rememberTokenField = 'sessionToken'
    }
    Member.useAdapter(createAdapter([]))

    await expect(Member.create({ passwordDigest: 'attacker' } as never)).rejects.toThrow(MassAssignmentException)
    await expect(Member.create({ sessionToken: 'forged' } as never)).rejects.toThrow(MassAssignmentException)
  })

  it('still hashes plaintext when password and hash share one column', async () => {
    // passwordField === passwordHashField is supported: the plaintext arrives under the
    // hash column's name and is hashed in place, so that column must not be denied.
    class InPlace extends AuthenticatableModel<PlainObject> {
      static override table = 'users'
      static override passwordField = 'passwordHash'
    }
    const captured: PlainObject[] = []
    InPlace.useAdapter(createAdapter(captured))

    await InPlace.create({ email: 'a@x.com', passwordHash: 'plaintext' } as never)

    const persisted = captured[0]
    expect(typeof persisted.passwordHash).toBe('string')
    expect(persisted.passwordHash).not.toBe('plaintext')
  })

  it('forceCreate and forceUpdate remain the trusted hatch for precomputed values', async () => {
    class User extends AuthenticatableModel<UserRecord> {
      static override table = 'users'
    }
    const captured: PlainObject[] = []
    User.useAdapter(createAdapter(captured))

    await User.forceCreate({ email: 'a@x.com', passwordHash: 'oauth:github' } as never)
    await User.forceUpdate({ id: 1 }, { rememberToken: 'rotated' } as never)

    expect(captured[0]).toMatchObject({ email: 'a@x.com', passwordHash: 'oauth:github' })
    expect(captured[1]).toMatchObject({ rememberToken: 'rotated' })
  })
})

describe('ModelUserProvider reads credential columns from the model contract', () => {
  it('resolves renamed columns without repeating them in provider options', async () => {
    class Member extends AuthenticatableModel<PlainObject> {
      static override table = 'members'
      static override passwordHashField = 'passwordDigest'
      static override rememberTokenField = 'sessionToken'
    }
    Member.useAdapter({
      async findMany<T extends PlainObject = PlainObject>(): Promise<T[]> {
        return [{ id: 1, email: 'a@x.com', sessionToken: 'tok' }] as unknown as T[]
      },
      async findUnique<T extends PlainObject = PlainObject>(): Promise<T | null> {
        return null
      },
    } as unknown as ORMAdapter)

    const provider = new ModelUserProvider(Member as unknown as typeof Model)

    const byToken = await provider.retrieveByCredentials({ rememberToken: 'tok' })
    expect(byToken).not.toBeNull()

    const clean = provider.sanitize({ id: 1, passwordDigest: 'h', sessionToken: 't', email: 'a@x.com' } as never)
    expect(clean).toEqual({ id: 1, email: 'a@x.com' } as never)
  })

  it('keeps explicit options as overrides while still blocking model columns in sanitize', () => {
    class Plain extends AuthenticatableModel<PlainObject> {
      static override table = 'users'
    }
    const provider = new ModelUserProvider(Plain as unknown as typeof Model, { passwordColumn: 'pw' })
    const clean = provider.sanitize({ pw: 'h', passwordHash: 'secret', rememberToken: 'x', id: 1 } as never)
    // An override must not reopen a leak through auth.user(): the model's own resolved
    // credential columns stay blocked alongside it.
    expect(clean).toEqual({ id: 1 } as never)
  })
})
