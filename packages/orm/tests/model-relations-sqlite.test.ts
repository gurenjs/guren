import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Model } from '../src/Model'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

// Integration test against the real bun:sqlite driver. The fake-adapter
// tests cannot catch SQL placeholder bugs (e.g. eq(column, array) binding
// one placeholder to N values), which broke eager loading for 2+ parents.

const usersTable = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})

const postsTable = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  authorId: integer('author_id').notNull(),
})

type UserRecord = typeof usersTable.$inferSelect
type PostRecord = typeof postsTable.$inferSelect

describe('relations on real bun:sqlite driver', () => {
  let sqlite: Database

  class User extends Model<UserRecord> {
    static override table = usersTable
  }

  class Post extends Model<PostRecord> {
    static override table = postsTable
  }

  User.hasMany('posts', Post, 'authorId', 'id')
  Post.belongsTo('author', User, 'authorId', 'id')

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE users (id integer primary key autoincrement, name text not null);
      CREATE TABLE posts (id integer primary key autoincrement, title text not null, author_id integer not null);
      INSERT INTO users (name) VALUES ('Alice'), ('Bob'), ('Carol');
      INSERT INTO posts (title, author_id) VALUES
        ('A1', 1), ('A2', 1), ('B1', 2);
    `)
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('should filter with array where (IN) across multiple values', async () => {
    const posts = await Post.where({ authorId: [1, 2] })
    expect(posts).toHaveLength(3)

    const single = await Post.where({ authorId: [2] })
    expect(single).toHaveLength(1)
    expect(single[0].title).toBe('B1')
  })

  it('should eager load hasMany for more than one parent record', async () => {
    const users = (await User.with('posts')) as Array<UserRecord & { posts: PostRecord[] }>

    expect(users).toHaveLength(3)
    expect(users.find((u) => u.name === 'Alice')?.posts.map((p) => p.title).sort()).toEqual(['A1', 'A2'])
    expect(users.find((u) => u.name === 'Bob')?.posts).toHaveLength(1)
    expect(users.find((u) => u.name === 'Carol')?.posts).toEqual([])
  })

  it('should eager load belongsTo across multiple children', async () => {
    const posts = (await Post.with('author')) as Array<PostRecord & { author: UserRecord | null }>

    expect(posts).toHaveLength(3)
    expect(posts.find((p) => p.title === 'A1')?.author?.name).toBe('Alice')
    expect(posts.find((p) => p.title === 'B1')?.author?.name).toBe('Bob')
  })

  it('should attach counts via withCount', async () => {
    const users = (await User.withCount('posts')) as Array<UserRecord & { postsCount: number }>

    expect(users.find((u) => u.name === 'Alice')?.postsCount).toBe(2)
    expect(users.find((u) => u.name === 'Bob')?.postsCount).toBe(1)
    expect(users.find((u) => u.name === 'Carol')?.postsCount).toBe(0)
  })

  it('should support orWhere with array values', async () => {
    const posts = await Post.where({ authorId: 1 }).orWhere({ authorId: [2] }).get()
    expect(posts).toHaveLength(3)
  })

  // paginate() once handed back the raw rows from executeQuery(), so
  // `.with('author').paginate(...)` returned pages whose relation was missing
  // while the same chain ending in `.get()` attached it — the blog starter's
  // /posts index rendered without author names because of it. It delegates to
  // get() now; these assert that on the real driver, which the in-memory
  // adapter used elsewhere cannot speak for.
  it('should eager load through paginate() like get() does', async () => {
    type PostWithAuthor = PostRecord & { author: UserRecord | null }

    const query = () => Post.newQuery().with('author').orderBy('id', 'desc')

    const viaGet = (await query().limit(2).get()) as PostWithAuthor[]
    const page = await query().paginate({ page: 1, perPage: 2 })
    const viaPaginate = page.data as PostWithAuthor[]

    expect(viaPaginate.map((p) => p.title)).toEqual(['B1', 'A2'])
    expect(viaPaginate.map((p) => p.author?.name)).toEqual(['Bob', 'Alice'])
    expect(viaPaginate).toEqual(viaGet)
    expect(page.meta).toMatchObject({ total: 3, perPage: 2, currentPage: 1, totalPages: 2, hasMore: true })

    // The remaining page loads its relation as well.
    const last = await query().paginate({ page: 2, perPage: 2 })
    expect((last.data as PostWithAuthor[]).map((p) => [p.title, p.author?.name])).toEqual([['A1', 'Alice']])
  })

  it('should eager load nested paths through paginate()', async () => {
    type UserWithPosts = UserRecord & { posts: Array<PostRecord & { author: UserRecord | null }> }

    const page = await User.newQuery().with('posts.author').orderBy('id', 'asc').paginate(1, 2)
    const users = page.data as UserWithPosts[]

    expect(users.map((u) => u.name)).toEqual(['Alice', 'Bob'])
    expect(users[0].posts.map((p) => p.title).sort()).toEqual(['A1', 'A2'])
    expect(users[0].posts.every((p) => p.author?.name === 'Alice')).toBe(true)
    expect(users[1].posts.map((p) => p.author?.name)).toEqual(['Bob'])
  })

  it('should restore the builder\'s own limit/offset after paginate()', async () => {
    type PostWithAuthor = PostRecord & { author: UserRecord | null }

    // The builder carries its own slice (rows 2..3); paginate() must not
    // leave its page-2 slice (row 3 only) behind, nor clear the slice.
    const builder = Post.newQuery().with('author').orderBy('id', 'asc').limit(2).offset(1)
    const page = await builder.paginate({ page: 2, perPage: 1 })
    expect((page.data as PostWithAuthor[]).map((p) => [p.title, p.author?.name])).toEqual([['A2', 'Alice']])

    const after = (await builder.get()) as PostWithAuthor[]
    expect(after.map((p) => [p.title, p.author?.name])).toEqual([['A2', 'Alice'], ['B1', 'Bob']])
  })
})
