import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Model } from '../src/Model'
import type { PlainObject } from '../src/Model'
import { SoftDeletes } from '../src/SoftDeletes'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

// Casts and accessors on every read path, against the real bun:sqlite driver.
// The adapter-direct fast paths (`all()`, `find()`) applied them and the
// QueryBuilder did not, so a model gained a global scope, or a caller added a
// `where()`, and its `json` column came back as a string.

const usersTable = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  prefs: text('prefs'),
  secret: text('secret'),
})

const postsTable = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  meta: text('meta'),
  authorId: integer('author_id').notNull(),
  deletedAt: text('deleted_at'),
})

type UserRecord = typeof usersTable.$inferSelect
type PostRecord = typeof postsTable.$inferSelect

type UserRow = Omit<UserRecord, 'prefs'> & { upperName: string; prefs: { theme: string } | null }
type PostRow = Omit<PostRecord, 'meta'> & { shout: string; meta: { tags: string[] } | null }

describe('read transforms on every query path (bun:sqlite)', () => {
  let sqlite: Database

  class User extends Model<UserRecord> {
    static override table = usersTable
    static override casts = { prefs: 'json' } as const
    static override accessors = { upperName: (r: PlainObject) => String(r.name).toUpperCase() }
    static override hidden = ['secret']
    static override appends = ['upperName']
  }

  class Post extends Model<PostRecord> {
    static override table = postsTable
    static override casts = { meta: 'json' } as const
    static override accessors = { shout: (r: PlainObject) => `${r.title}!` }
  }

  class ScopedPost extends Model<PostRecord> {
    static override table = postsTable
    static override casts = { meta: 'json' } as const
    static override accessors = { shout: (r: PlainObject) => `${r.title}!` }
  }
  ScopedPost.addGlobalScope('author', (q) => q.where('authorId', 1))

  class TrashablePost extends SoftDeletes(Model<PostRecord>) {
    static override table = postsTable
    static override casts = { meta: 'json' } as const
    static override accessors = { shout: (r: PlainObject) => `${r.title}!` }
  }

  User.hasMany('posts', Post, 'authorId', 'id')
  Post.belongsTo('author', User, 'authorId', 'id')

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE users (id integer primary key autoincrement, name text not null, prefs text, secret text);
      CREATE TABLE posts (id integer primary key autoincrement, title text not null, meta text, author_id integer not null, deleted_at text);
      INSERT INTO users (name, prefs, secret) VALUES ('alice', '{"theme":"dark"}', 'hunter2'), ('bob', NULL, 'swordfish');
      INSERT INTO posts (title, meta, author_id, deleted_at) VALUES
        ('a1', '{"tags":["x"]}', 1, NULL),
        ('a2', '{"tags":["y","z"]}', 1, '2020-01-01'),
        ('b1', NULL, 2, NULL);
    `)
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('applies casts and accessors on where().get()', async () => {
    const posts = (await Post.where('authorId', 1).get()) as PostRow[]
    expect(posts.map((p) => p.meta)).toEqual([{ tags: ['x'] }, { tags: ['y', 'z'] }])
    expect(posts.map((p) => p.shout)).toEqual(['a1!', 'a2!'])
  })

  it('applies casts and accessors on first()', async () => {
    const post = (await Post.where('title', 'a1').first()) as PostRow
    expect(post.meta).toEqual({ tags: ['x'] })
    expect(post.shout).toBe('a1!')
  })

  it('applies casts and accessors on Model.paginate() and QueryBuilder.paginate()', async () => {
    const direct = await Post.paginate({ perPage: 2 })
    expect((direct.data as PostRow[]).map((p) => p.meta)).toEqual([{ tags: ['x'] }, { tags: ['y', 'z'] }])
    expect((direct.data as PostRow[]).map((p) => p.shout)).toEqual(['a1!', 'a2!'])

    const built = await Post.newQuery().orderBy('id', 'desc').paginate({ perPage: 2 })
    expect((built.data as PostRow[]).map((p) => p.meta)).toEqual([null, { tags: ['y', 'z'] }])
    expect((built.data as PostRow[]).map((p) => p.shout)).toEqual(['b1!', 'a2!'])
  })

  it('applies casts and accessors on Model.orderBy()', async () => {
    const posts = (await Post.orderBy(['id', 'desc'])) as PostRow[]
    expect(posts.map((p) => p.shout)).toEqual(['b1!', 'a2!', 'a1!'])
    expect(posts[2].meta).toEqual({ tags: ['x'] })
  })

  it('applies casts and accessors on all() when the model carries a global scope', async () => {
    const posts = (await ScopedPost.all()) as PostRow[]
    expect(posts).toHaveLength(2)
    expect(posts[0].meta).toEqual({ tags: ['x'] })
    expect(posts[0].shout).toBe('a1!')
  })

  it('applies the related model transforms to a belongsTo eager load', async () => {
    const posts = (await Post.with('author')) as Array<PostRow & { author: UserRow | null }>
    const a1 = posts.find((p) => p.title === 'a1')!
    expect(a1.meta).toEqual({ tags: ['x'] })
    expect(a1.author?.prefs).toEqual({ theme: 'dark' })
    expect(a1.author?.upperName).toBe('ALICE')
  })

  it('applies the related model transforms to a hasMany eager load', async () => {
    const users = (await User.where('id', 1).with('posts').get()) as Array<UserRow & { posts: PostRow[] }>
    expect(users[0].prefs).toEqual({ theme: 'dark' })
    expect(users[0].upperName).toBe('ALICE')
    expect(users[0].posts.map((p) => p.meta)).toEqual([{ tags: ['x'] }, { tags: ['y', 'z'] }])
    expect(users[0].posts.map((p) => p.shout)).toEqual(['a1!', 'a2!'])
  })

  it('keeps hidden and appends on serialization of builder results', async () => {
    const users = await User.where('id', 1).get()
    const [json] = User.serializeMany(users)
    expect(json).toEqual({ id: 1, name: 'alice', prefs: { theme: 'dark' }, upperName: 'ALICE' })
  })

  it('keeps the SoftDeletes scope and applies transforms through it', async () => {
    const live = (await TrashablePost.all()) as PostRow[]
    expect(live.map((p) => p.title)).toEqual(['a1', 'b1'])
    expect(live[0].meta).toEqual({ tags: ['x'] })
    expect(live[0].shout).toBe('a1!')

    const trashed = (await TrashablePost.onlyTrashed().get()) as PostRow[]
    expect(trashed.map((p) => p.title)).toEqual(['a2'])
    expect(trashed[0].meta).toEqual({ tags: ['y', 'z'] })
  })
})
