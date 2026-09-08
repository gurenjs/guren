import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Model } from '../src/Model'
import { ModelNotFoundException } from '../src/ModelNotFoundException'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

// A criteria object whose every value is `undefined` renders no WHERE clause,
// so the query reaches every row. Verified against the real driver because the
// fallthrough only exists once Drizzle has built the statement.

const postsTable = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  published: integer('published', { mode: 'boolean' }).notNull(),
})

type PostRecord = typeof postsTable.$inferSelect

describe('unfiltered write guard on real bun:sqlite driver', () => {
  let sqlite: Database

  class Post extends Model<PostRecord> {
    static override table = postsTable
  }

  class ScopedPost extends Model<PostRecord> {
    static override table = postsTable
    static {
      this.addGlobalScope('publishedOnly', (q) => q.where('published', true))
    }
  }

  const rowCount = (): number =>
    sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM posts').get()?.n ?? -1

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE posts (
        id integer primary key autoincrement,
        title text not null,
        published integer not null
      );
      INSERT INTO posts (title, published) VALUES ('First', 1), ('Second', 1), ('Draft', 0);
    `)
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('should return null from find() for an undefined identifier', async () => {
    expect(await Post.find(undefined as never)).toBeNull()
  })

  it('should throw ModelNotFoundException from findOrFail() for an undefined identifier', async () => {
    await expect(Post.findOrFail(undefined as never)).rejects.toThrow(ModelNotFoundException)
  })

  it('should refuse a delete whose only filter was undefined', async () => {
    await expect(Post.delete({ id: undefined })).rejects.toThrow(/refusing to delete unfiltered/)
    expect(rowCount()).toBe(3)
  })

  it('should refuse an update whose only filter was undefined', async () => {
    await expect(Post.update({ id: undefined }, { title: 'pwned' })).rejects.toThrow(/refusing to update unfiltered/)
    const renamed = sqlite.query<{ n: number }, []>("SELECT count(*) AS n FROM posts WHERE title = 'pwned'").get()
    expect(renamed?.n).toBe(0)
  })

  it('should refuse a scoped builder delete whose only filter was undefined', async () => {
    await expect(ScopedPost.newQuery().where({ id: undefined }).delete()).rejects.toThrow(
      /refusing to delete unfiltered/,
    )
    expect(rowCount()).toBe(3)
  })

  it('should refuse a delete whose only filter was undefined inside a group', async () => {
    await expect(
      Post.newQuery().where((q) => q.where({ id: undefined })).delete(),
    ).rejects.toThrow(/refusing to delete unfiltered/)
    expect(rowCount()).toBe(3)
  })

  it('should return null from first() when every filter was undefined', async () => {
    expect(await Post.first({ title: undefined })).toBeNull()
    expect(await ScopedPost.first({ title: undefined })).toBeNull()
  })

  it('should agree with Model.first() when the same query is spelled on a builder', async () => {
    expect(await Post.newQuery().where({ title: undefined }).first()).toBeNull()
    await expect(Post.newQuery().where({ title: undefined }).firstOrFail()).rejects.toThrow(
      ModelNotFoundException,
    )
  })

  it('should still run when one filter of an optional set survives', async () => {
    await Post.newQuery().where({ published: true, title: undefined }).delete()

    const rows = sqlite.query<{ title: string }, []>('SELECT title FROM posts').all()
    expect(rows.map((r) => r.title)).toEqual(['Draft'])
  })

  it('should still allow a deliberately unfiltered builder delete', async () => {
    await Post.newQuery().delete()
    expect(rowCount()).toBe(0)
  })
})
