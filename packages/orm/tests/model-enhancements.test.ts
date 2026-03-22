import { describe, expect, it, beforeEach } from 'bun:test'
import {
  Model,
  defineModel,
  type FindManyOptions,
  type ORMAdapter,
  type PlainObject,
  type WhereClause,
} from '../src/Model'
import type { ModelObserver, ModelObserverConstructor } from '../src/ModelObserver'

type UserRecord = { id: number; name: string; email?: string; firstName?: string; lastName?: string; passwordHash?: string; active?: boolean; tenantId?: number; deletedAt?: string | null }

function createAdapter(records: UserRecord[] = []): ORMAdapter {
  const store = [...records]
  let nextId = records.length + 1

  return {
    async findMany<T extends PlainObject>(table: unknown, options?: FindManyOptions<T>): Promise<T[]> {
      const { where, limit, offset } = options ?? {}
      let results = where
        ? store.filter((r) =>
            Object.entries(where as PlainObject).every(([k, v]) => {
              if (Array.isArray(v)) return v.includes((r as PlainObject)[k])
              if (v === null) return (r as PlainObject)[k] == null
              return (r as PlainObject)[k] === v
            }),
          )
        : [...store]
      if (typeof offset === 'number') results = results.slice(offset)
      if (typeof limit === 'number') results = results.slice(0, limit)
      return results.map((r) => ({ ...r })) as unknown as T[]
    },
    async findUnique<T extends PlainObject>(table: unknown, where: WhereClause<T>): Promise<T | null> {
      const record = store.find((r) =>
        Object.entries(where as PlainObject).every(([k, v]) => (r as PlainObject)[k] === v),
      )
      return (record ? { ...record } : null) as unknown as T | null
    },
    async create<T extends PlainObject>(table: unknown, data: PlainObject): Promise<T> {
      const record = { ...data, id: nextId++ } as unknown as UserRecord
      store.push(record)
      return { ...record } as unknown as T
    },
    async update<T extends PlainObject>(table: unknown, where: WhereClause<T>, data: PlainObject): Promise<T> {
      const record = store.find((r) =>
        Object.entries(where as PlainObject).every(([k, v]) => (r as PlainObject)[k] === v),
      )
      if (!record) throw new Error('Not found')
      Object.assign(record, data)
      return { ...record } as unknown as T
    },
    async delete<T extends PlainObject>(table: unknown, where: WhereClause<T>): Promise<number> {
      const idx = store.findIndex((r) =>
        Object.entries(where as PlainObject).every(([k, v]) => (r as PlainObject)[k] === v),
      )
      if (idx === -1) return 0
      store.splice(idx, 1)
      return 1
    },
    async count<T extends PlainObject>(table: unknown, where?: WhereClause<T>): Promise<number> {
      if (!where) return store.length
      return store.filter((r) =>
        Object.entries(where as PlainObject).every(([k, v]) => (r as PlainObject)[k] === v),
      ).length
    },
  }
}

// =============================================================================
// Phase 1: Accessors & Mutators
// =============================================================================

describe('Phase 1: Accessors & Mutators', () => {
  it('applies accessors when reading records', async () => {
    class User extends Model<UserRecord> {
      static table = 'users'
      static accessors = {
        fullName: (r: PlainObject) => `${r.firstName} ${r.lastName}`,
      }
    }

    User.useAdapter(createAdapter([{ id: 1, name: 'test', firstName: 'John', lastName: 'Doe' }]))

    const user = await User.find(1)
    expect(user).not.toBeNull()
    expect((user as any).fullName).toBe('John Doe')
  })

  it('applies accessors on all()', async () => {
    class User extends Model<UserRecord> {
      static table = 'users'
      static accessors = {
        upperName: (r: PlainObject) => String(r.name).toUpperCase(),
      }
    }

    User.useAdapter(createAdapter([
      { id: 1, name: 'alice' },
      { id: 2, name: 'bob' },
    ]))

    const users = await User.all()
    expect((users[0] as any).upperName).toBe('ALICE')
    expect((users[1] as any).upperName).toBe('BOB')
  })

  it('applies mutators when creating records', async () => {
    class User extends Model<UserRecord> {
      static table = 'users'
      static mutators = {
        email: (value: unknown) => String(value).toLowerCase(),
      }
    }

    User.useAdapter(createAdapter([]))

    const user = await User.create({ name: 'Test', email: 'TEST@EXAMPLE.COM' } as any)
    expect(user.email).toBe('test@example.com')
  })

  it('applies mutators when updating records', async () => {
    class User extends Model<UserRecord> {
      static table = 'users'
      static mutators = {
        name: (value: unknown) => String(value).trim(),
      }
    }

    User.useAdapter(createAdapter([{ id: 1, name: 'original' }]))

    const updated = await User.update({ id: 1 }, { name: '  trimmed  ' } as any)
    expect(updated.name).toBe('trimmed')
  })
})

// =============================================================================
// Phase 2: Serialization
// =============================================================================

describe('Phase 2: Serialization', () => {
  it('hides fields listed in hidden', () => {
    class User extends Model<UserRecord> {
      static table = 'users'
      static hidden = ['passwordHash']
    }

    const result = User.serialize({ id: 1, name: 'Test', passwordHash: 'secret' } as UserRecord)
    expect(result).toEqual({ id: 1, name: 'Test' })
    expect(result).not.toHaveProperty('passwordHash')
  })

  it('only includes fields listed in visible', () => {
    class User extends Model<UserRecord> {
      static table = 'users'
      static visible = ['id', 'name']
    }

    const result = User.serialize({ id: 1, name: 'Test', email: 'test@test.com', passwordHash: 'secret' } as UserRecord)
    expect(result).toEqual({ id: 1, name: 'Test' })
  })

  it('appends virtual accessor attributes', () => {
    class User extends Model<UserRecord> {
      static table = 'users'
      static accessors = {
        fullName: (r: PlainObject) => `${r.firstName} ${r.lastName}`,
      }
      static appends = ['fullName']
      static hidden = ['firstName', 'lastName']
    }

    const result = User.serialize({ id: 1, name: 'test', firstName: 'John', lastName: 'Doe' } as UserRecord)
    expect(result.fullName).toBe('John Doe')
    expect(result).not.toHaveProperty('firstName')
    expect(result).not.toHaveProperty('lastName')
  })

  it('serializeMany works on arrays', () => {
    class User extends Model<UserRecord> {
      static table = 'users'
      static hidden = ['passwordHash']
    }

    const results = User.serializeMany([
      { id: 1, name: 'A', passwordHash: 'x' } as UserRecord,
      { id: 2, name: 'B', passwordHash: 'y' } as UserRecord,
    ])

    expect(results).toHaveLength(2)
    expect(results[0]).not.toHaveProperty('passwordHash')
    expect(results[1]).not.toHaveProperty('passwordHash')
  })
})

// =============================================================================
// Phase 3: Eager Loading on QueryBuilder
// =============================================================================

describe('Phase 3: QueryBuilder.with()', () => {
  it('loads relations via QueryBuilder.with()', async () => {
    type PostRecord = { id: number; title: string; authorId: number }

    class User extends Model<UserRecord> {
      static table = 'users'
    }

    class Post extends Model<PostRecord> {
      static table = 'posts'
    }

    User.hasMany('posts', Post, 'authorId', 'id')

    const stores = {
      users: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ] as UserRecord[],
      posts: [
        { id: 10, title: 'Post A', authorId: 1 },
        { id: 11, title: 'Post B', authorId: 1 },
        { id: 12, title: 'Post C', authorId: 2 },
      ] as PostRecord[],
    }

    const multiAdapter: ORMAdapter = {
      async findMany<T extends PlainObject>(table: unknown, options?: FindManyOptions<T>): Promise<T[]> {
        const store = table === 'users' ? stores.users : stores.posts
        const { where } = options ?? {}
        let results = where
          ? store.filter((r) =>
              Object.entries(where as PlainObject).every(([k, v]) => {
                if (Array.isArray(v)) return v.includes((r as PlainObject)[k])
                return (r as PlainObject)[k] === v
              }),
            )
          : [...store]
        return results.map((r) => ({ ...r })) as unknown as T[]
      },
      async findUnique<T extends PlainObject>(table: unknown, where: WhereClause<T>): Promise<T | null> {
        const store = table === 'users' ? stores.users : stores.posts
        const record = store.find((r) =>
          Object.entries(where as PlainObject).every(([k, v]) => (r as PlainObject)[k] === v),
        )
        return (record ? { ...record } : null) as unknown as T | null
      },
      async create<T extends PlainObject>(table: unknown, data: PlainObject): Promise<T> {
        return data as unknown as T
      },
    }

    User.useAdapter(multiAdapter)
    Post.useAdapter(multiAdapter)

    const users = await User.where({ name: 'Alice' }).with('posts').get() as any[]
    expect(users).toHaveLength(1)
    expect(users[0].posts).toHaveLength(2)
    expect(users[0].posts[0].title).toBe('Post A')
  })

  it('loads relations via first().with()', async () => {
    type PostRecord = { id: number; title: string; authorId: number }

    class User extends Model<UserRecord> {
      static table = 'users'
    }

    class Post extends Model<PostRecord> {
      static table = 'posts'
    }

    User.hasMany('posts', Post, 'authorId', 'id')

    const stores = {
      users: [{ id: 1, name: 'Alice' }] as UserRecord[],
      posts: [{ id: 10, title: 'Post A', authorId: 1 }] as PostRecord[],
    }

    const multiAdapter: ORMAdapter = {
      async findMany<T extends PlainObject>(table: unknown, options?: FindManyOptions<T>): Promise<T[]> {
        const store = table === 'users' ? stores.users : stores.posts
        const { where, limit } = options ?? {}
        let results = where
          ? store.filter((r) =>
              Object.entries(where as PlainObject).every(([k, v]) => {
                if (Array.isArray(v)) return v.includes((r as PlainObject)[k])
                return (r as PlainObject)[k] === v
              }),
            )
          : [...store]
        if (typeof limit === 'number') results = results.slice(0, limit)
        return results.map((r) => ({ ...r })) as unknown as T[]
      },
      async findUnique<T extends PlainObject>(): Promise<T | null> { return null },
      async create<T extends PlainObject>(table: unknown, data: PlainObject): Promise<T> { return data as unknown as T },
    }

    User.useAdapter(multiAdapter)
    Post.useAdapter(multiAdapter)

    const user = await User.newQuery().with('posts').first() as any
    expect(user).not.toBeNull()
    expect(user.posts).toHaveLength(1)
  })
})

// =============================================================================
// Phase 4: Model Observers
// =============================================================================

describe('Phase 4: Model Observers', () => {
  it('fires observer creating/created hooks', async () => {
    const log: string[] = []

    class UserObserver implements ModelObserver {
      creating(data: PlainObject) { log.push(`creating:${data.name}`) }
      created(data: PlainObject) { log.push(`created:${data.id}`) }
    }

    class User extends Model<UserRecord> {
      static table = 'users'
    }

    User.useAdapter(createAdapter([]))
    User.observe(UserObserver as ModelObserverConstructor)

    await User.create({ name: 'Test' } as any)
    expect(log).toContain('creating:Test')
    expect(log.some((l) => l.startsWith('created:'))).toBe(true)

    User.clearObservers()
  })

  it('observer can abort create by returning false', async () => {
    class BlockingObserver implements ModelObserver {
      creating() { return false as const }
    }

    class User extends Model<UserRecord> {
      static table = 'users'
    }

    User.useAdapter(createAdapter([]))
    User.observe(BlockingObserver as ModelObserverConstructor)

    await expect(User.create({ name: 'Blocked' } as any)).rejects.toThrow('aborted by observer')

    User.clearObservers()
  })

  it('fires observer updating/updated hooks', async () => {
    const log: string[] = []

    class UserObserver implements ModelObserver {
      updating(data: PlainObject) { log.push(`updating:${data.name}`) }
      updated(data: PlainObject) { log.push(`updated:${data.name}`) }
    }

    class User extends Model<UserRecord> {
      static table = 'users'
    }

    User.useAdapter(createAdapter([{ id: 1, name: 'Old' }]))
    User.observe(UserObserver as ModelObserverConstructor)

    await User.update({ id: 1 }, { name: 'New' } as any)
    expect(log).toContain('updating:New')
    expect(log).toContain('updated:New')

    User.clearObservers()
  })

  it('fires observer deleting/deleted hooks', async () => {
    const log: string[] = []

    class UserObserver implements ModelObserver {
      deleting(data: PlainObject) { log.push('deleting') }
      deleted(data: PlainObject) { log.push('deleted') }
    }

    class User extends Model<UserRecord> {
      static table = 'users'
    }

    User.useAdapter(createAdapter([{ id: 1, name: 'Test' }]))
    User.observe(UserObserver as ModelObserverConstructor)

    await User.delete({ id: 1 })
    expect(log).toEqual(['deleting', 'deleted'])

    User.clearObservers()
  })

  it('works alongside existing hooks', async () => {
    const log: string[] = []

    class UserObserver implements ModelObserver {
      creating() { log.push('observer:creating') }
      created() { log.push('observer:created') }
    }

    class User extends Model<UserRecord> {
      static table = 'users'
      static hooks = {
        creating: () => { log.push('hook:creating') },
        created: () => { log.push('hook:created') },
      }
    }

    User.useAdapter(createAdapter([]))
    User.observe(UserObserver as ModelObserverConstructor)

    await User.create({ name: 'Test' } as any)

    // Hooks fire before observers
    expect(log.indexOf('hook:creating')).toBeLessThan(log.indexOf('observer:creating'))
    expect(log.indexOf('hook:created')).toBeLessThan(log.indexOf('observer:created'))

    User.clearObservers()
  })
})

// =============================================================================
// Phase 5: Global Scopes
// =============================================================================

describe('Phase 5: Global Scopes', () => {
  it('applies named global scopes to queries', async () => {
    class User extends Model<UserRecord> {
      static table = 'users'
    }

    User.useAdapter(createAdapter([
      { id: 1, name: 'Active', active: true },
      { id: 2, name: 'Inactive', active: false },
    ]))

    User.addGlobalScope('active', (q) => q.where('active', true))

    const users = await User.all()
    expect(users).toHaveLength(1)
    expect(users[0].name).toBe('Active')

    User.removeGlobalScope('active')
  })

  it('withoutGlobalScope excludes specific scopes', async () => {
    class User extends Model<UserRecord> {
      static table = 'users'
    }

    User.useAdapter(createAdapter([
      { id: 1, name: 'Active', active: true, tenantId: 1 },
      { id: 2, name: 'Inactive', active: false, tenantId: 1 },
      { id: 3, name: 'Other', active: true, tenantId: 2 },
    ]))

    User.addGlobalScope('active', (q) => q.where('active', true))
    User.addGlobalScope('tenant', (q) => q.where('tenantId', 1))

    // Both scopes applied
    const scoped = await User.newQuery().get()
    expect(scoped).toHaveLength(1)
    expect(scoped[0].name).toBe('Active')

    // Without 'active' scope
    const withInactive = await User.withoutGlobalScope('active').get()
    expect(withInactive).toHaveLength(2) // tenantId=1 only

    User.removeGlobalScope('active')
    User.removeGlobalScope('tenant')
  })

  it('withoutGlobalScopes skips all scopes', async () => {
    class User extends Model<UserRecord> {
      static table = 'users'
    }

    User.useAdapter(createAdapter([
      { id: 1, name: 'A', active: true },
      { id: 2, name: 'B', active: false },
    ]))

    User.addGlobalScope('active', (q) => q.where('active', true))

    const all = await User.withoutGlobalScopes().get()
    expect(all).toHaveLength(2)

    User.removeGlobalScope('active')
  })

  it('global scopes work with find() via defaultScope path', async () => {
    class User extends Model<UserRecord> {
      static table = 'users'
    }

    User.useAdapter(createAdapter([
      { id: 1, name: 'Active', active: true },
      { id: 2, name: 'Deleted', active: false },
    ]))

    // Using defaultScope (which find() checks)
    User.defaultScope = (q) => q.where('active', true)

    const found = await User.find(2)
    // find() with defaultScope goes through newQuery, which should filter
    expect(found).toBeNull()

    User.defaultScope = undefined
  })
})
