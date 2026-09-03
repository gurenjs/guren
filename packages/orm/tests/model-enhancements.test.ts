import { describe, expect, it } from 'bun:test'
import {
  Model,
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
  type PostRecord = { id: number; title: string; authorId: number }

  // One in-memory adapter over several tables: the eager loader queries the
  // related table through the same adapter the parent model uses.
  function createMultiAdapter(stores: Record<string, PlainObject[]>): ORMAdapter {
    const matches = (where: PlainObject) => (r: PlainObject) =>
      Object.entries(where).every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v))
    const rows = (table: unknown) => stores[String(table)] ?? []

    return {
      async findMany<T extends PlainObject>(table: unknown, options?: FindManyOptions<T>): Promise<T[]> {
        const { where, limit, offset } = options ?? {}
        let results = where ? rows(table).filter(matches(where as PlainObject)) : [...rows(table)]
        if (typeof offset === 'number') results = results.slice(offset)
        if (typeof limit === 'number') results = results.slice(0, limit)
        return results.map((r) => ({ ...r })) as unknown as T[]
      },
      async findUnique<T extends PlainObject>(table: unknown, where: WhereClause<T>): Promise<T | null> {
        const record = rows(table).find(matches(where as PlainObject))
        return (record ? { ...record } : null) as unknown as T | null
      },
      async create<T extends PlainObject>(table: unknown, data: PlainObject): Promise<T> {
        return data as unknown as T
      },
      async count(table: unknown): Promise<number> {
        return rows(table).length
      },
    }
  }

  function defineBlog(stores: Record<string, PlainObject[]>) {
    class User extends Model<UserRecord> {
      static table = 'users'
    }
    class Post extends Model<PostRecord> {
      static table = 'posts'
    }
    User.hasMany('posts', Post, 'authorId', 'id')
    Post.belongsTo('author', User, 'authorId', 'id')

    const adapter = createMultiAdapter(stores)
    User.useAdapter(adapter)
    Post.useAdapter(adapter)
    return { User, Post }
  }

  it('loads relations via QueryBuilder.with()', async () => {
    const { User } = defineBlog({
      users: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
      posts: [
        { id: 10, title: 'Post A', authorId: 1 },
        { id: 11, title: 'Post B', authorId: 1 },
        { id: 12, title: 'Post C', authorId: 2 },
      ],
    })

    const users = await User.where({ name: 'Alice' }).with('posts').get() as any[]
    expect(users).toHaveLength(1)
    expect(users[0].posts).toHaveLength(2)
    expect(users[0].posts[0].title).toBe('Post A')
  })

  it('loads relations via first().with()', async () => {
    const { User } = defineBlog({
      users: [{ id: 1, name: 'Alice' }],
      posts: [{ id: 10, title: 'Post A', authorId: 1 }],
    })

    const user = await User.newQuery().with('posts').first() as any
    expect(user).not.toBeNull()
    expect(user.posts).toHaveLength(1)
  })

  it('loads relations via with().paginate()', async () => {
    const { Post } = defineBlog({
      users: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
      posts: [
        { id: 10, title: 'Post A', authorId: 1 },
        { id: 11, title: 'Post B', authorId: 2 },
        { id: 12, title: 'Post C', authorId: 1 },
      ],
    })

    const page = await Post.newQuery().with('author').paginate({ page: 1, perPage: 2 }) as any
    expect(page.meta.total).toBe(3)
    expect(page.data).toHaveLength(2)
    expect(page.data[0].author).toMatchObject({ id: 1, name: 'Alice' })
    expect(page.data[1].author).toMatchObject({ id: 2, name: 'Bob' })

    const last = await Post.newQuery().with('author').paginate({ page: 2, perPage: 2 }) as any
    expect(last.data).toHaveLength(1)
    expect(last.data[0].author).toMatchObject({ id: 1, name: 'Alice' })
  })

  it('restores limit/offset when eager loading fails in first() and paginate()', async () => {
    const { Post } = defineBlog({
      users: [{ id: 1, name: 'Alice' }],
      // Enough rows that both queries fetch something: an empty page never
      // reaches the eager loader, so it could not fail there.
      posts: Array.from({ length: 5 }, (_, i) => ({ id: 10 + i, title: `Post ${i}`, authorId: 1 })),
    })

    const query = Post.newQuery().with('missing').limit(5).offset(3)
    await expect(query.first()).rejects.toThrow('unknown relation "missing"')
    await expect(query.paginate({ page: 1, perPage: 1 })).rejects.toThrow('unknown relation "missing"')
    expect(query.getOptions()).toMatchObject({ limitValue: 5, offsetValue: 3 })
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
      deleting(_data: PlainObject) { log.push('deleting') }
      deleted(_data: PlainObject) { log.push('deleted') }
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

// =============================================================================
// Global scopes on every query entry point
// =============================================================================

describe('global scopes apply on every query entry point', () => {
  // The docs recommend global scopes for multi-tenancy ("any filter that should
  // always be active"), so an entry point that drops the scope is a tenant
  // isolation hole, not just a missing filter.
  function tenantScopedUser() {
    class User extends Model<UserRecord> {
      static table = 'users'
      static scopes = {
        named: (q: any) => q.where('active', true),
      }
    }

    User.useAdapter(createAdapter([
      { id: 1, name: 'Ours', tenantId: 1, active: true, deletedAt: null },
      { id: 2, name: 'Theirs', tenantId: 2, active: true, deletedAt: null },
      { id: 3, name: 'Theirs too', tenantId: 2, active: false, deletedAt: null },
    ]))
    User.addGlobalScope('tenant', (q) => q.where('tenantId', 1))

    return User
  }

  function names(records: PlainObject[]): string[] {
    return records.map((record) => String(record.name))
  }

  it('applies the scope to where()', async () => {
    const User = tenantScopedUser()
    expect(names(await User.where('active', true).get())).toEqual(['Ours'])
    expect(names(await User.where({ active: true }).get())).toEqual(['Ours'])
  })

  // A flat where-object holds one value per field, so a caller's condition on
  // the scoped column used to overwrite the scope's — handing them another
  // tenant's rows through the very filter meant to stop that.
  it('refuses when a condition would overwrite the scope on the same field', async () => {
    const User = tenantScopedUser()

    await expect(User.where('tenantId', 2).get()).rejects.toThrow('return unfiltered rows')
  })

  it('still collapses a condition that repeats the scope value', async () => {
    const User = tenantScopedUser()

    expect(names(await User.where('tenantId', 1).get())).toEqual(['Ours'])
  })

  it('applies the scope to whereIn()', async () => {
    const User = tenantScopedUser()
    expect(names(await User.whereIn('id', [1, 2, 3]).get())).toEqual(['Ours'])
  })

  it('applies the scope to whereNull()', async () => {
    const User = tenantScopedUser()
    expect(names(await User.whereNull('deletedAt').get())).toEqual(['Ours'])
  })

  // `not in` / `is not null` have no simple-where representation. On a basic
  // adapter the builder used to fall back to `where: undefined`, dropping the
  // tenant scope along with the condition and returning every row. Refusing is
  // the only safe answer; the shipped Drizzle adapter implements
  // findManyAdvanced and never reaches this path.
  it('refuses rather than dropping conditions a basic adapter cannot express', async () => {
    const User = tenantScopedUser()

    await expect(User.whereNotIn('id', [99]).get()).rejects.toThrow('return unfiltered rows')
    await expect(User.whereNotNull('name').get()).rejects.toThrow('return unfiltered rows')
  })

  it('applies the scope to select()', async () => {
    const User = tenantScopedUser()
    expect(await User.select('id', 'name').get()).toHaveLength(1)
  })

  it('applies the scope to a named scope()', async () => {
    const User = tenantScopedUser()
    expect(names(await User.scope('named').get())).toEqual(['Ours'])
  })

  it('applies the scope to orderBy()', async () => {
    const User = tenantScopedUser()
    expect(names(await User.orderBy('id'))).toEqual(['Ours'])
  })

  it('applies the scope to paginate(), including the count', async () => {
    const User = tenantScopedUser()
    const result = await User.paginate({ page: 1, perPage: 10 })

    expect(names(result.data)).toEqual(['Ours'])
    // An unscoped count leaks how many rows the other tenants hold.
    expect(result.meta.total).toBe(1)
  })

  it('still lets withoutGlobalScopes() opt out', async () => {
    const User = tenantScopedUser()
    expect(await User.withoutGlobalScopes().get()).toHaveLength(3)
    expect(await User.withoutGlobalScope('tenant').get()).toHaveLength(3)
  })

  // Writes are the sharp edge: reads that leak are a disclosure, but an
  // update/delete that skips the tenant scope mutates another tenant's data.
  it('applies the scope to update() — a write cannot cross the tenant boundary', async () => {
    const User = tenantScopedUser()
    // id 2 belongs to tenant 2; the tenant-1 scope must keep this write off it.
    await User.update({ id: 2 }, { name: 'Hacked' } as any).catch(() => {})
    const theirs = await User.withoutGlobalScopes().where('id', 2).first()
    expect(theirs?.name).toBe('Theirs')
  })

  it('applies the scope to update() — a write still lands within the tenant', async () => {
    const User = tenantScopedUser()
    await User.update({ id: 1 }, { name: 'Renamed' } as any)
    const ours = await User.withoutGlobalScopes().where('id', 1).first()
    expect(ours?.name).toBe('Renamed')
  })

  it('applies the scope to delete() — a delete cannot cross the tenant boundary', async () => {
    const User = tenantScopedUser()
    await User.delete({ id: 2 }).catch(() => {})
    const theirs = await User.withoutGlobalScopes().where('id', 2).first()
    expect(theirs?.name).toBe('Theirs')
  })

  it('applies the scope to delete() — a delete still lands within the tenant', async () => {
    const User = tenantScopedUser()
    await User.delete({ id: 1 })
    expect(await User.withoutGlobalScopes().where('id', 1).first()).toBeNull()
  })

  // The scoped write path borrows the builder's conditions but must reuse the
  // payload runUpdate already prepared — re-preparing would run mutators twice
  // (e.g. double-hash a hashed column).
  it('runs mutators exactly once on a scoped update', async () => {
    let calls = 0
    class User extends Model<UserRecord> {
      static table = 'users'
      static mutators = {
        name: (v: unknown) => {
          calls++
          return `[${String(v)}]`
        },
      }
    }
    User.useAdapter(createAdapter([{ id: 1, name: 'orig', tenantId: 1 }]))
    User.addGlobalScope('tenant', (q) => q.where('tenantId', 1))

    const updated = await User.update({ id: 1 }, { name: 'x' } as any)
    expect(updated.name).toBe('[x]')
    expect(calls).toBe(1)

    User.removeGlobalScope('tenant')
  })

  it("applies the related model's scope when eager loading", async () => {
    type PostRecord = { id: number; title: string; authorId: number; deletedAt?: string | null }

    class User extends Model<UserRecord> {
      static table = 'users'
    }

    class Post extends Model<PostRecord> {
      static table = 'posts'
    }

    const stores = {
      users: [{ id: 1, name: 'Alice' }] as UserRecord[],
      posts: [
        { id: 10, title: 'Live', authorId: 1, deletedAt: null },
        { id: 11, title: 'Retracted', authorId: 1, deletedAt: '2026-01-01' },
      ] as PostRecord[],
    }

    const adapter: ORMAdapter = {
      async findMany<T extends PlainObject>(table: unknown, options?: FindManyOptions<T>): Promise<T[]> {
        const store = (table === 'users' ? stores.users : stores.posts) as PlainObject[]
        const { where } = options ?? {}
        const results = where
          ? store.filter((r) =>
              Object.entries(where as PlainObject).every(([k, v]) => {
                if (Array.isArray(v)) return v.includes(r[k])
                if (v === null) return r[k] == null
                return r[k] === v
              }),
            )
          : [...store]
        return results.map((r) => ({ ...r })) as unknown as T[]
      },
      async findUnique(): Promise<null> { return null },
      async create<T extends PlainObject>(): Promise<T> { throw new Error('unused') },
      async update<T extends PlainObject>(): Promise<T> { throw new Error('unused') },
      async delete(): Promise<number> { return 0 },
    }

    User.useAdapter(adapter)
    Post.useAdapter(adapter)
    User.hasMany('posts', Post, 'authorId', 'id')
    Post.addGlobalScope('notRetracted', (q) => q.whereNull('deletedAt'))

    const [user] = await User.with('posts')
    const posts = (user as unknown as { posts: PostRecord[] }).posts

    expect(posts.map((post) => post.title)).toEqual(['Live'])

    Post.removeGlobalScope('notRetracted')
  })
})
