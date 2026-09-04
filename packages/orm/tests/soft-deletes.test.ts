import { describe, expect, it } from 'bun:test'
import {
  Model,
  type FindManyOptions,
  type ORMAdapter,
  type PlainObject,
  type WhereClause,
} from '../src/Model'
import { SoftDeletes } from '../src/SoftDeletes'
import type { WhereCondition } from '../src/QueryBuilder'

/**
 * Soft deletes on a multi-tenant model: a write path that hands the caller's
 * `where` straight to the adapter drops every global scope, so `forceDelete()`
 * permanently removes another tenant's rows. `withTrashed()` / `onlyTrashed()`
 * are the mirror image — they must escape the softDelete filter without
 * dropping the other scopes.
 */

type PostRecord = {
  id: number
  title: string
  tenantId: number
  deletedAt: Date | null
}

// Rows carry an explicit `deletedAt: null` because the write path matches on
// `deletedAt IS NULL`, and an absent field is not a null one for a strict matcher.
const SEED: PostRecord[] = [
  { id: 1, title: 'ours-live', tenantId: 1, deletedAt: null },
  { id: 2, title: 'ours-trashed', tenantId: 1, deletedAt: new Date('2020-01-01') },
  { id: 3, title: 'theirs-live', tenantId: 2, deletedAt: null },
  { id: 4, title: 'theirs-trashed', tenantId: 2, deletedAt: new Date('2020-01-01') },
]

function matchesSimple(record: PlainObject, where: PlainObject): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (Array.isArray(v)) return v.includes(record[k])
    if (v === null) return record[k] == null
    return record[k] === v
  })
}

function matchesConditions(record: PlainObject, conditions: WhereCondition[]): boolean {
  return conditions.every((condition) => {
    if (condition.type !== 'simple') {
      throw new Error('test adapter only models simple conditions')
    }
    const actual = record[condition.field]
    switch (condition.operator) {
      case '=':
        return actual === condition.value
      case 'is null':
        return actual == null
      case 'is not null':
        return actual != null
      case 'in':
        return (condition.value as unknown[]).includes(actual)
      default:
        throw new Error(`test adapter does not model operator ${condition.operator}`)
    }
  })
}

/**
 * Reads go through `findManyAdvanced` because `onlyTrashed()`'s `IS NOT NULL`
 * cannot survive the simple-where conversion. Writes deliberately have no
 * `updateAdvanced` / `deleteAdvanced`, so they exercise the
 * `toSimpleWhereClause()` fallback.
 */
function createAdapter(store: PostRecord[]): ORMAdapter {
  return {
    async findMany<T extends PlainObject>(_table: unknown, options?: FindManyOptions<T>): Promise<T[]> {
      const where = options?.where as PlainObject | undefined
      const rows = where ? store.filter((r) => matchesSimple(r, where)) : [...store]
      return rows.map((r) => ({ ...r })) as unknown as T[]
    },
    async findManyAdvanced<T extends PlainObject>(_table: unknown, conditions: WhereCondition[]): Promise<T[]> {
      return store.filter((r) => matchesConditions(r, conditions)).map((r) => ({ ...r })) as unknown as T[]
    },
    async findUnique<T extends PlainObject>(_table: unknown, where: WhereClause<T>): Promise<T | null> {
      const record = store.find((r) => matchesSimple(r, where as PlainObject))
      return (record ? { ...record } : null) as unknown as T | null
    },
    async create<T extends PlainObject>(_table: unknown, data: PlainObject): Promise<T> {
      const record = { ...data, id: store.length + 1 } as unknown as PostRecord
      store.push(record)
      return { ...record } as unknown as T
    },
    async update<T extends PlainObject>(_table: unknown, where: WhereClause<T>, data: PlainObject): Promise<T> {
      const record = store.find((r) => matchesSimple(r, where as PlainObject))
      // A no-match write must not silently look like a success.
      if (!record) throw new Error('Not found')
      Object.assign(record, data)
      return { ...record } as unknown as T
    },
    async delete<T extends PlainObject>(_table: unknown, where: WhereClause<T>): Promise<number> {
      const idx = store.findIndex((r) => matchesSimple(r, where as PlainObject))
      if (idx === -1) return 0
      store.splice(idx, 1)
      return 1
    },
    async count<T extends PlainObject>(_table: unknown, where?: WhereClause<T>): Promise<number> {
      if (!where) return store.length
      return store.filter((r) => matchesSimple(r, where as PlainObject)).length
    },
  } as ORMAdapter
}

/**
 * A fresh class per test. `withoutGlobalScope()` installs an own registry as a
 * side effect of reading, so a shared class would carry state between tests.
 */
function tenantScopedPost() {
  const store = SEED.map((r) => ({ ...r }))

  class Post extends SoftDeletes(Model<PostRecord>) {
    static table = 'posts'
  }
  Post.useAdapter(createAdapter(store))
  // Registered on the subclass, after the mixin registered 'softDelete' on the
  // class it built: this composition must not shadow the inherited registry.
  ;(Post as unknown as typeof Model).addGlobalScope('tenant', (q) => q.where('tenantId', 1))

  return { Post, store }
}

const titles = (rows: PlainObject[]) => rows.map((r) => r.title as string).sort()

describe('SoftDeletes: reads', () => {
  it('excludes trashed rows and other tenants from the default query', async () => {
    // softDelete is not registered as a `defaultScope`, so the only thing hiding
    // trashed rows is the named scope reaching the subclass through the cloned registry.
    const { Post } = tenantScopedPost()
    expect(titles(await Post.all())).toEqual(['ours-live'])
  })

  it('keeps the inherited softDelete scope when the mixin is applied over an already-scoped base', async () => {
    // Reverse composition order: the base already carries a scope, so the mixin's
    // `addGlobalScope` is the call that must not start from an empty registry.
    const store = SEED.map((r) => ({ ...r }))

    class Base extends Model<PostRecord> {
      static table = 'posts'
    }
    Base.addGlobalScope('tenant', (q) => q.where('tenantId', 1))

    class Post extends SoftDeletes(Base) {}
    Post.useAdapter(createAdapter(store))

    expect(titles(await Post.all())).toEqual(['ours-live'])
  })

  it('withTrashed() reaches trashed rows but stays inside the tenant', async () => {
    const { Post } = tenantScopedPost()
    expect(titles(await Post.withTrashed().get())).toEqual(['ours-live', 'ours-trashed'])
  })

  it('onlyTrashed() returns this tenant\'s trashed rows and no one else\'s', async () => {
    const { Post } = tenantScopedPost()
    expect(titles(await Post.onlyTrashed().get())).toEqual(['ours-trashed'])
  })

  it('withoutGlobalScope("softDelete") is what withTrashed() does — the documented equivalence', async () => {
    const { Post } = tenantScopedPost()
    const viaHelper = titles(await Post.withTrashed().get())
    const viaScopeName = titles(await (Post as unknown as typeof Model).withoutGlobalScope('softDelete').get())

    expect(viaScopeName).toEqual(viaHelper)
    expect(viaScopeName).toEqual(['ours-live', 'ours-trashed'])
  })

  it('withoutGlobalScopes() still drops everything, tenant included', async () => {
    const { Post } = tenantScopedPost()
    expect(await (Post as unknown as typeof Model).withoutGlobalScopes().get()).toHaveLength(4)
  })
})

describe('SoftDeletes: delete()', () => {
  it('soft-deletes a live row inside the tenant', async () => {
    const { Post, store } = tenantScopedPost()
    await Post.delete({ id: 1 })

    expect(store.find((r) => r.id === 1)?.deletedAt).toBeInstanceOf(Date)
    expect(titles(await Post.all())).toEqual([])
  })

  it('cannot soft-delete another tenant\'s row', async () => {
    const { Post, store } = tenantScopedPost()
    await Post.delete({ id: 3 }).catch(() => {})

    expect(store.find((r) => r.id === 3)?.deletedAt).toBeNull()
  })

  it('leaves an already-trashed row\'s deletedAt alone', async () => {
    // The softDelete scope is applied here too, so a second delete matches
    // nothing rather than refreshing the timestamp — documented in the guide.
    const { Post, store } = tenantScopedPost()
    const original = store.find((r) => r.id === 2)!.deletedAt

    await Post.delete({ id: 2 }).catch(() => {})

    expect(store.find((r) => r.id === 2)?.deletedAt).toBe(original)
  })

  it('leaves the row in place for the other tenant to read', async () => {
    const { Post, store } = tenantScopedPost()
    await Post.delete({ id: 3 }).catch(() => {})

    class OtherTenantPost extends SoftDeletes(Model<PostRecord>) {
      static table = 'posts'
    }
    OtherTenantPost.useAdapter(createAdapter(store))
    ;(OtherTenantPost as unknown as typeof Model).addGlobalScope('tenant', (q) => q.where('tenantId', 2))

    expect(titles(await OtherTenantPost.all())).toEqual(['theirs-live'])
  })
})

describe('SoftDeletes: restore()', () => {
  it('restores a trashed row inside the tenant', async () => {
    const { Post, store } = tenantScopedPost()
    await Post.restore({ id: 2 })

    expect(store.find((r) => r.id === 2)?.deletedAt).toBeNull()
    expect(titles(await Post.all())).toEqual(['ours-live', 'ours-trashed'])
  })

  it('cannot restore another tenant\'s trashed row', async () => {
    const { Post, store } = tenantScopedPost()
    await Post.restore({ id: 4 }).catch(() => {})

    expect(store.find((r) => r.id === 4)?.deletedAt).toBeInstanceOf(Date)
  })
})

describe('SoftDeletes: forceDelete()', () => {
  it('hard-deletes a trashed row inside the tenant', async () => {
    const { Post, store } = tenantScopedPost()
    await Post.forceDelete({ id: 2 })

    expect(store.find((r) => r.id === 2)).toBeUndefined()
  })

  it('hard-deletes a live row inside the tenant', async () => {
    // Dropping only the softDelete scope must not turn forceDelete into a
    // trashed-rows-only operation.
    const { Post, store } = tenantScopedPost()
    await Post.forceDelete({ id: 1 })

    expect(store.find((r) => r.id === 1)).toBeUndefined()
  })

  it('cannot hard-delete another tenant\'s trashed row', async () => {
    // The sharpest case in the whole mixin: this delete is unrecoverable.
    const { Post, store } = tenantScopedPost()
    await Post.forceDelete({ id: 4 }).catch(() => {})

    expect(store.find((r) => r.id === 4)).toBeDefined()
  })

  it('cannot hard-delete another tenant\'s live row', async () => {
    const { Post, store } = tenantScopedPost()
    await Post.forceDelete({ id: 3 }).catch(() => {})

    expect(store.find((r) => r.id === 3)).toBeDefined()
  })
})

describe('SoftDeletes: models with no other scopes', () => {
  it('still soft-deletes, restores, and force-deletes', async () => {
    const store = SEED.map((r) => ({ ...r }))

    class Post extends SoftDeletes(Model<PostRecord>) {
      static table = 'posts'
    }
    Post.useAdapter(createAdapter(store))

    await Post.delete({ id: 1 })
    expect(store.find((r) => r.id === 1)?.deletedAt).toBeInstanceOf(Date)

    await Post.restore({ id: 1 })
    expect(store.find((r) => r.id === 1)?.deletedAt).toBeNull()

    await Post.forceDelete({ id: 1 })
    expect(store.find((r) => r.id === 1)).toBeUndefined()
  })

  it('reports the adapter gap rather than silently doing nothing', async () => {
    class Post extends SoftDeletes(Model<PostRecord>) {
      static table = 'posts'
    }
    Post.useAdapter({ ...createAdapter([]), update: undefined, delete: undefined } as unknown as ORMAdapter)

    await expect(Post.delete({ id: 1 })).rejects.toThrow('needed for soft delete')
    await expect(Post.restore({ id: 1 })).rejects.toThrow('needed for restore')
    await expect(Post.forceDelete({ id: 1 })).rejects.toThrow('does not support delete operations')
  })
})
