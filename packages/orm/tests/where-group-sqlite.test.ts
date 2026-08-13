import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Model } from '../src/Model'
import { SoftDeletes } from '../src/SoftDeletes'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

// Integration test against the real bun:sqlite driver. Callback groups only
// exist so that AND filters (published flags, soft deletes, global scopes)
// survive next to OR keyword chains — the fake-adapter tests cannot prove
// the Drizzle renderer parenthesizes the generated SQL the same way.

const postsTable = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  excerpt: text('excerpt').notNull(),
  published: integer('published', { mode: 'boolean' }).notNull(),
  deletedAt: text('deleted_at'),
})

type PostRecord = typeof postsTable.$inferSelect

describe('callback where groups on real bun:sqlite driver', () => {
  let sqlite: Database

  class Post extends Model<PostRecord> {
    static override table = postsTable
  }

  class SoftPost extends SoftDeletes(Model<PostRecord>) {
    static override table = postsTable
  }

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE posts (
        id integer primary key autoincrement,
        title text not null,
        excerpt text not null,
        published integer not null,
        deleted_at text
      );
      INSERT INTO posts (title, excerpt, published, deleted_at) VALUES
        ('Bun speed',      'runtime notes',   1, NULL),
        ('Draft on bun',   'unfinished',      0, NULL),
        ('Hono routing',   'try it with bun', 1, NULL),
        ('Deleted bun',    'gone',            1, '2026-01-01T00:00:00Z'),
        ('Unrelated',      'nothing here',    1, NULL);
    `)
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('should keep an AND filter next to an OR keyword group', async () => {
    const posts = await Post.where((q) => {
      q.where('title', 'like', '%bun%').orWhere('excerpt', 'like', '%bun%')
    }).where('published', true)

    // Without grouping, `published = true` would be OR'd away and the
    // unpublished draft would leak through.
    expect(posts.map((p) => p.title).sort()).toEqual(['Bun speed', 'Deleted bun', 'Hono routing'])
  })

  it('should match any keyword when all OR pairs share one group (blog template shape)', async () => {
    const posts = await Post.newQuery()
      .where((q) => {
        for (const keyword of ['speed', 'routing']) {
          const pattern = `%${keyword}%`
          q.orWhere('title', 'like', pattern).orWhere('excerpt', 'like', pattern)
        }
      })
      .where('published', true)
      .get()

    // (title/excerpt ~ speed OR title/excerpt ~ routing) AND published
    expect(posts.map((p) => p.title).sort()).toEqual(['Bun speed', 'Hono routing'])
  })

  it('should stack keyword groups for multiple keywords', async () => {
    const query = Post.newQuery().where('published', true)
    for (const keyword of ['bun', 'routing']) {
      const pattern = `%${keyword}%`
      query.where((q) => q.where('title', 'like', pattern).orWhere('excerpt', 'like', pattern))
    }
    const posts = await query.get()

    // published AND (title/excerpt ~ bun) AND (title/excerpt ~ routing)
    expect(posts.map((p) => p.title)).toEqual(['Hono routing'])
  })

  it('should not let orWhere groups escape the soft-delete scope', async () => {
    const posts = await SoftPost.where((q) => {
      q.where('title', 'like', '%bun%').orWhere('excerpt', 'like', '%bun%')
    }).where('published', true)

    expect(posts.map((p) => p.title).sort()).toEqual(['Bun speed', 'Hono routing'])
  })

  it('should OR a whole callback group against preceding conditions', async () => {
    const posts = await Post.where('published', false)
      .orWhere((q) => q.where('title', 'like', '%Hono%').where('published', true))
      .get()

    // published = false OR (title ~ Hono AND published = true)
    expect(posts.map((p) => p.title).sort()).toEqual(['Draft on bun', 'Hono routing'])
  })

  it('should render nested callbacks inside callbacks', async () => {
    const posts = await Post.where((q) => {
      q.where('published', true)
      q.where((inner) => inner.where('title', 'like', '%speed%').orWhere('excerpt', 'like', '%nothing%'))
    }).whereNull('deletedAt')

    expect(posts.map((p) => p.title).sort()).toEqual(['Bun speed', 'Unrelated'])
  })

  it('should apply grouped conditions to bulk update and delete', async () => {
    await Post.newQuery()
      .where((q) => q.where('title', 'like', '%bun%').orWhere('excerpt', 'like', '%bun%'))
      .where('published', true)
      .forceUpdate({ excerpt: 'matched' })

    const updated = sqlite.query<{ n: number }, []>("SELECT count(*) AS n FROM posts WHERE excerpt = 'matched'").get()
    expect(updated?.n).toBe(3)

    const deleted = await Post.newQuery()
      .where((q) => q.where('published', false).orWhere('deletedAt', 'is not null', null))
      .delete()
    expect(deleted).toBeDefined()

    const remaining = sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM posts').get()
    expect(remaining?.n).toBe(3)
  })
})
