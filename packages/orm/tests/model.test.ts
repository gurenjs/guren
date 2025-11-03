import { describe, expect, it } from 'bun:test'
import {
  Model,
  type FindManyOptions,
  type OrderByClause,
  type ORMAdapter,
  type PlainObject,
  type WhereClause,
} from '../src/Model'

type UserRecord = { id: number; name: string; team?: string }
type PostRecord = { id: number; title: string; authorId: number }

function createAdapter(records: UserRecord[] = []): { adapter: ORMAdapter; snapshot: () => UserRecord[] } {
  let nextId = records.length + 1
  const store = [...records]

  function matches(where?: WhereClause<UserRecord>) {
    if (!where) {
      return () => true
    }

    return (record: UserRecord) =>
      Object.entries(where as PlainObject).every(([key, value]) => (record as PlainObject)[key] === value)
  }

  function compare(orderBy: OrderByClause<UserRecord>) {
    return (left: UserRecord, right: UserRecord) => {
      for (const { column, direction } of orderBy) {
        const a = (left as PlainObject)[column]
        const b = (right as PlainObject)[column]

        if (a === b) {
          continue
        }

        if (a == null) {
          return direction === 'asc' ? -1 : 1
        }

        if (b == null) {
          return direction === 'asc' ? 1 : -1
        }

        if (a > b) {
          return direction === 'asc' ? 1 : -1
        }

        if (a < b) {
          return direction === 'asc' ? -1 : 1
        }
      }

      return 0
    }
  }

  const adapter: ORMAdapter = {
    async findMany<TRecord extends PlainObject = PlainObject>(
      table: unknown,
      options?: FindManyOptions<TRecord>,
    ): Promise<TRecord[]> {
      expect(table).toBe('users')
      const { where, orderBy } = options ?? {}
      let results = store.filter(matches(where as WhereClause<UserRecord> | undefined))

      if (orderBy && orderBy.length > 0) {
        results = [...results].sort(compare(orderBy as OrderByClause<UserRecord>))
      }

      return results.map((record) => ({ ...record })) as unknown as TRecord[]
    },

    async findUnique<TRecord extends PlainObject = PlainObject>(table: unknown, where: WhereClause<TRecord>): Promise<TRecord | null> {
      expect(table).toBe('users')
      const record = store.find(matches(where as WhereClause<UserRecord>))
      return (record ? { ...record } : null) as unknown as TRecord | null
    },

    async create<TRecord extends PlainObject = PlainObject>(table: unknown, data: PlainObject): Promise<TRecord> {
      expect(table).toBe('users')
      const record = { ...(data as UserRecord), id: nextId++ } as UserRecord
      store.push(record)
      return { ...record } as unknown as TRecord
    },

    async update<TRecord extends PlainObject = PlainObject>(table: unknown, where: WhereClause<TRecord>, data: PlainObject): Promise<TRecord> {
      expect(table).toBe('users')
      const record = store.find(matches(where as WhereClause<UserRecord>))

      if (!record) {
        throw new Error('Record not found')
      }

      Object.assign(record, data)
      return { ...record } as unknown as TRecord
    },

    async delete<TRecord extends PlainObject = PlainObject>(table: unknown, where: WhereClause<TRecord>): Promise<number> {
      expect(table).toBe('users')
      const index = store.findIndex(matches(where as WhereClause<UserRecord>))
      if (index === -1) {
        return 0
      }

      store.splice(index, 1)
      return 1
    },
  }

  return {
    adapter,
    snapshot: () => store.map((record) => ({ ...record })),
  }
}

function createRelationalAdapter(data: { users?: UserRecord[]; posts?: PostRecord[] } = {}): ORMAdapter {
  const stores = {
    users: [...(data.users ?? [])],
    posts: [...(data.posts ?? [])],
  }

  function clone(record: PlainObject): PlainObject {
    return { ...record }
  }

  function getStore(table: unknown): PlainObject[] {
    if (table === 'users') {
      return stores.users as unknown as PlainObject[]
    }

    if (table === 'posts') {
      return stores.posts as unknown as PlainObject[]
    }

    throw new Error(`Unknown table: ${String(table)}`)
  }

  function applyWhere(records: PlainObject[], where?: WhereClause<PlainObject>): PlainObject[] {
    if (!where) {
      return records
    }

    const entries = Object.entries(where).filter(([, value]) => value !== undefined)

    return records.filter((record) =>
      entries.every(([key, value]) => {
        const current = record[key]

        if (Array.isArray(value)) {
          return value.some((candidate) => candidate === current)
        }

        if (value === null) {
          return current === null
        }

        return current === value
      }),
    )
  }

  const adapter: ORMAdapter = {
    async findMany<TRecord extends PlainObject = PlainObject>(
      table: unknown,
      options?: FindManyOptions<TRecord>,
    ): Promise<TRecord[]> {
      const { where } = options ?? {}
      const store = getStore(table).map(clone)
      const filtered = applyWhere(store, where as WhereClause<PlainObject> | undefined)
      return filtered as unknown as TRecord[]
    },

    async findUnique<TRecord extends PlainObject = PlainObject>(
      table: unknown,
      where: WhereClause<TRecord>,
    ): Promise<TRecord | null> {
      const store = getStore(table)
      const [record] = applyWhere(store.map(clone), where as WhereClause<PlainObject> | undefined)
      return (record ? { ...record } : null) as unknown as TRecord | null
    },

    async create<TRecord extends PlainObject = PlainObject>(table: unknown, data: PlainObject): Promise<TRecord> {
      const store = getStore(table)
      const record = { ...data } as PlainObject
      store.push(record)
      return { ...record } as unknown as TRecord
    },
  }

  return adapter
}

describe('Model', () => {
  it('delegates CRUD helpers to the configured adapter', async () => {
    class User extends Model<UserRecord> {
      static table = 'users'
    }

    const { adapter, snapshot } = createAdapter([{ id: 1, name: 'Daiki', team: 'core' }])
    User.useAdapter(adapter)

    expect(await User.all()).toEqual(snapshot())
    expect(await User.find(1)).toEqual({ id: 1, name: 'Daiki', team: 'core' })
    expect(await User.where({ team: 'core' })).toEqual([{ id: 1, name: 'Daiki', team: 'core' }])

    const created = (await User.create({ name: 'Asuka', team: 'infra' })) as UserRecord
    expect(created.id).toBeGreaterThan(1)
    expect(created.name).toBe('Asuka')

    const updated = (await User.update({ id: created.id }, { team: 'platform' })) as UserRecord
    expect(updated).toEqual({ id: created.id, name: 'Asuka', team: 'platform' })

    const deletedCount = await User.delete({ id: 1 })
    expect(deletedCount).toBe(1)
  })

  it('orders results when an order clause is provided', async () => {
    class User extends Model<UserRecord> {
      static table = 'users'
    }

    const { adapter } = createAdapter([
      { id: 1, name: 'Misato', team: 'operations' },
      { id: 2, name: 'Shinji', team: 'pilots' },
      { id: 3, name: 'Asuka', team: 'pilots' },
      { id: 4, name: 'Rei', team: 'pilots' },
    ])

    User.useAdapter(adapter)

    const byName = await User.orderBy('name')
    expect(byName.map((user) => user.name)).toEqual(['Asuka', 'Misato', 'Rei', 'Shinji'])

    const pilotsDesc = await User.orderBy([['team', 'asc'], ['name', 'desc']], { team: 'pilots' })
    expect(pilotsDesc.map((user) => user.name)).toEqual(['Shinji', 'Rei', 'Asuka'])
  })

  it('throws a descriptive error when the table property is missing', async () => {
    class Untethered extends Model<UserRecord> {}

    await expect(Untethered.all()).rejects.toThrow('Untethered.table must be defined before using the model.')
  })

  it('loads hasMany and belongsTo relations', async () => {
    class User extends Model<UserRecord> {
      static table = 'users'
    }

    class Post extends Model<PostRecord> {
      static table = 'posts'
    }

    User.hasMany('posts', Post, 'authorId', 'id')
    Post.belongsTo('author', User, 'authorId', 'id')

    const adapter = createRelationalAdapter({
      users: [
        { id: 1, name: 'Misato', team: 'operations' },
        { id: 2, name: 'Shinji', team: 'pilots' },
        { id: 3, name: 'Asuka', team: 'pilots' },
      ],
      posts: [
        { id: 10, title: 'Logistics update', authorId: 1 },
        { id: 11, title: 'Sync ratios', authorId: 2 },
        { id: 12, title: 'Eva training', authorId: 2 },
      ],
    })

    User.useAdapter(adapter)
    Post.useAdapter(adapter)

    const usersWithPosts = (await User.with('posts')) as Array<UserRecord & { posts: PostRecord[] }>
    const misato = usersWithPosts.find((user) => user.id === 1)
    const shinji = usersWithPosts.find((user) => user.id === 2)
    const asuka = usersWithPosts.find((user) => user.id === 3)

    expect(misato?.posts).toEqual([{ id: 10, title: 'Logistics update', authorId: 1 }])
    expect(shinji?.posts).toEqual([
      { id: 11, title: 'Sync ratios', authorId: 2 },
      { id: 12, title: 'Eva training', authorId: 2 },
    ])
    expect(asuka?.posts).toEqual([])

    const postsWithAuthor = (await Post.with('author', { id: 11 })) as Array<PostRecord & { author: UserRecord | null }>
    expect(postsWithAuthor).toHaveLength(1)
    expect(postsWithAuthor[0].author?.name).toBe('Shinji')
  })
})
