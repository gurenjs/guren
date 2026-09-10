import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Model } from '../src/Model'
import { SoftDeletes } from '../src/SoftDeletes'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

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

describe('withCount on the real bun:sqlite driver', () => {
  let sqlite: Database
  let log: string[]

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

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE users (id integer primary key autoincrement, name text not null);
      CREATE TABLE posts (id integer primary key autoincrement, title text not null, author_id integer not null, deleted_at text);
      CREATE TABLE images (id integer primary key autoincrement, url text not null, imageable_type text not null, imageable_id integer not null);
      INSERT INTO users (name) VALUES ('Alice'), ('Bob'), ('Carol');
      INSERT INTO posts (title, author_id, deleted_at) VALUES
        ('A1', 1, NULL), ('A2', 1, NULL), ('A3-trashed', 1, '2020-01-01'), ('B1', 2, NULL);
      INSERT INTO images (url, imageable_type, imageable_id) VALUES
        ('a.png', 'Post', 1), ('b.png', 'Post', 1), ('u.png', 'User', 1), ('c.png', 'Post', 2);
    `)
    log = []
    DrizzleAdapter.configure(drizzle({ client: sqlite, logger: { logQuery: (sql) => void log.push(sql) } }) as never)
  })

  afterEach(() => {
    sqlite.close()
  })

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
    sqlite.exec(`INSERT INTO posts (title, author_id) VALUES ('orphan', 99)`)
    const posts = (await Post.withCount('author')) as Array<PostRecord & { authorCount: number }>

    expect(posts.map((p) => [p.title, p.authorCount])).toEqual([['A1', 1], ['A2', 1], ['B1', 1], ['orphan', 0]])

    const [query, ...rest] = queriesOn('users')
    expect(rest).toEqual([])
    expect(query).toContain('count(*)')
    expect(query).not.toContain('"name"')
  })

  it('splits the IN list into chunks of at most 500 keys', async () => {
    const rows = Array.from({ length: 1197 }, (_, i) => `('u${i}')`).join(',')
    sqlite.exec(`INSERT INTO users (name) VALUES ${rows}`)

    const users = (await User.withCount('posts')) as Array<UserRecord & { postsCount: number }>

    expect(users).toHaveLength(1200)
    expect(users.slice(0, 3).map((u) => u.postsCount)).toEqual([2, 1, 0])
    expect(queriesOn('posts')).toHaveLength(3)
  })

  it('chunks an eager load the same way', async () => {
    const rows = Array.from({ length: 1197 }, (_, i) => `('u${i}')`).join(',')
    sqlite.exec(`INSERT INTO users (name) VALUES ${rows}`)

    const users = (await User.with('posts')) as Array<UserRecord & { posts: PostRecord[] }>

    expect(users).toHaveLength(1200)
    expect(users.slice(0, 3).map((u) => u.posts.length)).toEqual([2, 1, 0])
    expect(queriesOn('posts')).toHaveLength(3)
  })
})
