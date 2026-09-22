import { describe, expect, it } from 'bun:test'
import {
  Model,
  type FindManyOptions,
  type ORMAdapter,
  type PlainObject,
  type WhereClause,
} from '../src/Model'

type UserRecord = { id: number; name: string }
type PostRecord = { id: number; title: string; authorId: number }
type CommentRecord = { id: number; body: string; postId: number; authorId: number }

function createMultiAdapter(stores: Record<string, PlainObject[]>, queries: string[] = []): ORMAdapter {
  return {
    async findMany<T extends PlainObject>(table: unknown, options?: FindManyOptions<T>): Promise<T[]> {
      queries.push(String(table))
      const store = stores[String(table)] ?? []
      const { where } = options ?? {}
      const results = where
        ? store.filter((r) =>
            Object.entries(where as PlainObject).every(([k, v]) => {
              if (Array.isArray(v)) return v.includes(r[k])
              return r[k] === v
            }),
          )
        : [...store]
      return results.map((r) => ({ ...r })) as unknown as T[]
    },
    async findUnique<T extends PlainObject>(table: unknown, where: WhereClause<T>): Promise<T | null> {
      queries.push(String(table))
      const store = stores[String(table)] ?? []
      const record = store.find((r) =>
        Object.entries(where as PlainObject).every(([k, v]) => r[k] === v),
      )
      return (record ? { ...record } : null) as unknown as T | null
    },
    async create<T extends PlainObject>(_table: unknown, data: PlainObject): Promise<T> {
      return data as unknown as T
    },
  }
}

function setupModels() {
  class User extends Model<UserRecord> {
    static table = 'users'
  }
  class Post extends Model<PostRecord> {
    static table = 'posts'
  }
  class Comment extends Model<CommentRecord> {
    static table = 'comments'
  }

  User.hasMany('posts', Post, 'authorId', 'id')
  Post.hasMany('comments', Comment, 'postId', 'id')
  Post.belongsTo('author', User, 'authorId', 'id')

  const queries: string[] = []
  const adapter = createMultiAdapter({
    users: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ],
    posts: [
      { id: 10, title: 'Post A', authorId: 1 },
      { id: 11, title: 'Post B', authorId: 1 },
      { id: 12, title: 'Post C', authorId: 2 },
    ],
    comments: [
      { id: 100, body: 'First!', postId: 10, authorId: 2 },
      { id: 101, body: 'Nice', postId: 10, authorId: 1 },
      { id: 102, body: 'Agreed', postId: 12, authorId: 1 },
    ],
  }, queries)

  User.useAdapter(adapter)
  Post.useAdapter(adapter)
  Comment.useAdapter(adapter)

  return { User, Post, Comment, queries }
}

describe('nested eager loading', () => {
  it('should load nested relations with dot notation', async () => {
    const { User } = setupModels()

    const users = (await User.with('posts.comments')) as any[]
    const alice = users.find((u) => u.name === 'Alice')

    expect(alice.posts).toHaveLength(2)
    const postA = alice.posts.find((p: any) => p.title === 'Post A')
    expect(postA.comments).toHaveLength(2)
    expect(postA.comments[0].body).toBe('First!')

    const postB = alice.posts.find((p: any) => p.title === 'Post B')
    expect(postB.comments).toHaveLength(0)
  })

  it('should load nested belongsTo under hasMany', async () => {
    const { User, Post } = setupModels()

    const posts = (await Post.with('author')) as any[]
    expect(posts.find((p) => p.title === 'Post A').author.name).toBe('Alice')

    const users = (await User.with('posts.comments')) as any[]
    expect(users).toHaveLength(2)
  })

  it('should throw for unknown nested relation head', async () => {
    const { User } = setupModels()
    await expect(User.with('nope.comments')).rejects.toThrow('unknown relation "nope"')
  })

  it('should work through QueryBuilder.with()', async () => {
    const { User } = setupModels()

    const users = (await User.where({ name: 'Alice' }).with('posts.comments').get()) as any[]
    expect(users).toHaveLength(1)
    const postA = users[0].posts.find((p: any) => p.title === 'Post A')
    expect(postA.comments).toHaveLength(2)
  })

  it('should load three-level nesting (posts.comments.author)', async () => {
    const { User, Comment } = setupModels()
    Comment.belongsTo('author', User, 'authorId', 'id')

    const users = (await User.with('posts.comments.author')) as any[]
    const alice = users.find((u) => u.name === 'Alice')
    const postA = alice.posts.find((p: any) => p.title === 'Post A')

    expect(postA.comments).toHaveLength(2)
    expect(postA.comments[0].author).toBeDefined()
    expect(postA.comments[0].author.name).toBe('Bob')
  })

  it('should load three-level nesting through QueryBuilder.with()', async () => {
    const { User, Comment } = setupModels()
    Comment.belongsTo('author', User, 'authorId', 'id')

    const users = (await User.where({ name: 'Alice' }).with('posts.comments.author').get()) as any[]
    const postA = users[0].posts.find((p: any) => p.title === 'Post A')

    expect(postA.comments[0].author).toBeDefined()
    expect(postA.comments[0].author.name).toBe('Bob')
    expect(postA.comments[1].author.name).toBe('Alice')
  })
})

describe('withCount', () => {
  it('should attach hasMany counts without loading relation rows', async () => {
    const { User } = setupModels()

    const users = (await User.withCount('posts')) as any[]
    const alice = users.find((u) => u.name === 'Alice')
    const bob = users.find((u) => u.name === 'Bob')

    expect(alice.postsCount).toBe(2)
    expect(bob.postsCount).toBe(1)
    expect(alice.posts).toBeUndefined()
  })

  it('should attach belongsTo counts as 0 or 1', async () => {
    const { Post } = setupModels()

    const posts = (await Post.withCount('author')) as any[]
    expect(posts.every((p) => p.authorCount === 1)).toBe(true)
  })

  it('should support a where filter and multiple relations', async () => {
    const { Post } = setupModels()

    const posts = (await Post.withCount(['comments', 'author'], { authorId: 1 })) as any[]
    expect(posts).toHaveLength(2)
    const postA = posts.find((p) => p.title === 'Post A')
    expect(postA.commentsCount).toBe(2)
    expect(postA.authorCount).toBe(1)
  })

  it('should reject nested relation paths', async () => {
    const { User } = setupModels()
    await expect(User.withCount('posts.comments')).rejects.toThrow('does not support nested relation')
  })

  it('should reject unknown relations', async () => {
    const { User } = setupModels()
    await expect(User.withCount('nope')).rejects.toThrow('unknown relation "nope"')
  })
})

describe('relation loader boundaries', () => {
  it('loads a shared head once while preserving both nested branches', async () => {
    const { User, queries } = setupModels()
    const rows = await User.with(['posts.comments', 'posts.author', 'posts'])
    expect(queries).toEqual(['users', 'posts', 'comments', 'users'])
    const posts = rows[0].posts as PlainObject[]
    expect(posts[0].comments).toHaveLength(2)
    expect(posts[0].author).toMatchObject({ name: 'Alice' })
  })

  it('dispatches through protected overrides for parent and nested loaders', async () => {
    const { User, Post, queries } = setupModels()
    const calls: string[] = []
    class CustomUser extends User {
      protected static override async loadHasMany(...args: Parameters<typeof Model.loadHasMany>): Promise<boolean> {
        calls.push('hasMany')
        return super.loadHasMany(...args)
      }
    }
    class CustomPost extends Post {
      protected static override async loadBelongsTo(...args: Parameters<typeof Model.loadBelongsTo>): Promise<boolean> {
        calls.push('belongsTo')
        return super.loadBelongsTo(...args)
      }
    }
    CustomPost.belongsTo('author', User, 'authorId', 'id')
    CustomUser.hasMany('posts', CustomPost, 'authorId', 'id')
    const rows = await CustomUser.with('posts.author')
    expect(rows).toHaveLength(2)
    expect(calls).toEqual(['hasMany', 'belongsTo'])
    expect(queries).toEqual(['users', 'posts', 'users'])
  })

  it('skips descendant queries when a scoped head has no rows', async () => {
    const { User, Post, queries } = setupModels()
    Post.addGlobalScope('hidden', query => query.where({ id: -1 }))
    const rows = await User.with('posts.comments')
    expect(rows.map(row => row.posts)).toEqual([[], []])
    expect(queries).toEqual(['users', 'posts'])
  })
})
