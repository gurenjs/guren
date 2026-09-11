import { describe, expect, it } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { DEFAULT_IN_LIST_SIZE } from '../src/internal-keys'
import { Model } from '../src/Model'
import { SoftDeletes } from '../src/SoftDeletes'
import { useSqlite } from './sqlite-fixture'

// withCount() against the real bun:sqlite driver, with drizzle's logger as the
// query log: the counts have to come from a GROUP BY, never from loading the
// related rows and counting them in JS.

const usersTable = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})

const postsTable = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  authorId: integer('author_id').notNull(),
  deletedAt: text('deleted_at'),
})

const imagesTable = sqliteTable('images', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  url: text('url').notNull(),
  imageableType: text('imageable_type').notNull(),
  imageableId: integer('imageable_id').notNull(),
})

type UserRecord = typeof usersTable.$inferSelect
type PostRecord = typeof postsTable.$inferSelect
type ImageRecord = typeof imagesTable.$inferSelect

const log: string[] = []

const sqlite = useSqlite(`
  CREATE TABLE users (id integer primary key autoincrement, name text not null);
  CREATE TABLE posts (id integer primary key autoincrement, title text not null, author_id integer not null, deleted_at text);
  CREATE TABLE images (id integer primary key autoincrement, url text not null, imageable_type text not null, imageable_id integer not null);
  INSERT INTO users (name) VALUES ('Alice'), ('Bob'), ('Carol');
  INSERT INTO posts (title, author_id, deleted_at) VALUES
    ('A1', 1, NULL), ('A2', 1, NULL), ('A3-trashed', 1, '2020-01-01'), ('B1', 2, NULL);
  INSERT INTO images (url, imageable_type, imageable_id) VALUES
    ('a.png', 'Post', 1), ('b.png', 'Post', 1), ('u.png', 'User', 1), ('c.png', 'Post', 2);
`, { log })

const SEEDED_USERS = 3
/** Parents enough to need this many IN lists, at the size the adapter reports. */
const CHUNK_COUNT = 3
const CHUNKED_USERS = DEFAULT_IN_LIST_SIZE * (CHUNK_COUNT - 1) + 1

describe('withCount on the real bun:sqlite driver', () => {
  class User extends Model<UserRecord> {
    static override table = usersTable
  }

  class Post extends SoftDeletes(Model<PostRecord>) {
    static override table = postsTable
  }

  class Image extends Model<ImageRecord> {
    static override table = imagesTable
  }

  User.hasMany('posts', Post, 'authorId', 'id')
  Post.belongsTo('author', User, 'authorId', 'id')
  Post.morphMany('images', Image, 'imageable', 'id')

  const queriesOn = (table: string) => log.filter((sql) => sql.includes(`from "${table}"`))

  const seedUsers = () => {
    const rows = Array.from({ length: CHUNKED_USERS - SEEDED_USERS }, (_, i) => `('u${i}')`).join(',')
    sqlite().exec(`INSERT INTO users (name) VALUES ${rows}`)
  }

  it('counts a hasMany relation with a grouped COUNT and no row fetch', async () => {
    const users = (await User.withCount('posts')) as Array<UserRecord & { postsCount: number }>

    expect(users.map((u) => u.postsCount)).toEqual([2, 1, 0])

    const [query, ...rest] = queriesOn('posts')
    expect(rest).toEqual([])
    expect(query).toContain('count(*)')
    expect(query).toContain('group by')
    expect(query).not.toContain('"title"')
  })

  it('counts a morphMany relation with a grouped COUNT scoped to the parent type', async () => {
    const posts = (await Post.withCount('images')) as Array<PostRecord & { imagesCount: number }>

    expect(posts.map((p) => [p.title, p.imagesCount])).toEqual([['A1', 2], ['A2', 1], ['B1', 0]])

    const [query, ...rest] = queriesOn('images')
    expect(rest).toEqual([])
    expect(query).toContain('count(*)')
    expect(query).toContain('group by')
    expect(query).toContain('"imageable_type"')
    expect(query).not.toContain('"url"')
  })

  it('counts a belongsTo relation as 0 or 1 without loading the owner', async () => {
    sqlite().exec(`INSERT INTO posts (title, author_id) VALUES ('orphan', 99)`)
    const posts = (await Post.withCount('author')) as Array<PostRecord & { authorCount: number }>

    expect(posts.map((p) => [p.title, p.authorCount])).toEqual([['A1', 1], ['A2', 1], ['B1', 1], ['orphan', 0]])

    // 0 or 1, so the owner rows only have to be shown to exist: the key column
    // alone, never a grouped COUNT over rows nothing else reads.
    const [query, ...rest] = queriesOn('users')
    expect(rest).toEqual([])
    expect(query).toContain('select "id" from "users"')
    expect(query).not.toContain('"name"')
  })

  it(`splits the IN list into chunks of at most ${DEFAULT_IN_LIST_SIZE} keys`, async () => {
    seedUsers()

    const users = (await User.withCount('posts')) as Array<UserRecord & { postsCount: number }>

    expect(users.slice(0, 3).map((u) => u.postsCount)).toEqual([2, 1, 0])
    expect(queriesOn('posts')).toHaveLength(CHUNK_COUNT)
  })

  it('chunks an eager load the same way', async () => {
    seedUsers()

    const users = (await User.with('posts')) as Array<UserRecord & { posts: PostRecord[] }>

    expect(users.slice(0, 3).map((u) => u.posts.length)).toEqual([2, 1, 0])
    expect(queriesOn('posts')).toHaveLength(CHUNK_COUNT)
  })

  it('still chunks when the constraint only filters', async () => {
    seedUsers()

    const users = (await User.newQuery()
      .with({ posts: (q) => q.where('title', '!=', 'nothing') })
      .get()) as Array<UserRecord & { posts: PostRecord[] }>

    expect(users.slice(0, 3).map((u) => u.posts.length)).toEqual([2, 1, 0])
    expect(queriesOn('posts')).toHaveLength(CHUNK_COUNT)
  })

  it('issues one query when the constraint limits the result set', async () => {
    seedUsers()

    const users = (await User.newQuery()
      .with({ posts: (q) => q.orderBy('id', 'desc').limit(3) })
      .get()) as Array<UserRecord & { posts: PostRecord[] }>

    // `limit` describes the whole result set, so splitting the IN list would
    // answer a different question: three rows per chunk rather than three in all.
    expect(queriesOn('posts')).toHaveLength(1)
    // Three rows in all, grouped back under the parents they belong to.
    expect(users.flatMap((user) => user.posts).map((post) => post.title)).toEqual(['A2', 'A1', 'B1'])
  })
})
