import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Model } from '../src/Model'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

// Integration test against the real bun:sqlite driver, whose drizzle
// `transaction()` COMMITs on whatever the callback returns without awaiting it.
// Only a real driver can show whether a write survived a throw, which is why the
// SQL-shape tests next door pass whether or not the transaction is atomic.

const postsTable = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
})

type PostRecord = typeof postsTable.$inferSelect

describe('Model.transaction on the real bun:sqlite driver', () => {
  let sqlite: Database

  class Post extends Model<PostRecord> {
    static override table = postsTable
  }

  const titles = () => (sqlite.query('SELECT title FROM posts ORDER BY id').all() as PostRecord[]).map((r) => r.title)

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE posts (id integer primary key autoincrement, title text not null);
      INSERT INTO posts (title) VALUES ('original');
    `)
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('should roll back a write when the async callback throws', async () => {
    await expect(
      Post.transaction(async (_trx, txPost) => {
        await txPost.create({ title: 'inserted' })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(titles()).toEqual(['original'])
  })

  it('should commit every write when the async callback returns', async () => {
    const result = await Post.transaction(async (_trx, txPost) => {
      await txPost.create({ title: 'first' })
      await txPost.create({ title: 'second' })
      return 'done'
    })

    expect(result).toBe('done')
    expect(titles()).toEqual(['original', 'first', 'second'])
  })

  it('should leave the connection usable after a rollback', async () => {
    await expect(
      Post.transaction(async (_trx, txPost) => {
        await txPost.create({ title: 'discarded' })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await Post.transaction(async (_trx, txPost) => {
      await txPost.create({ title: 'kept' })
    })

    expect(titles()).toEqual(['original', 'kept'])
  })

  it('should refuse an overlapping transaction without disturbing the open one', async () => {
    const outer = Post.transaction(async (_trx, txPost) => {
      await txPost.create({ title: 'outer-a' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      await txPost.create({ title: 'outer-b' })
      return 'outer'
    })

    const overlapping = Post.transaction(async (_trx, txPost) => {
      await txPost.create({ title: 'overlapping' })
    })

    await expect(overlapping).rejects.toThrow('could not begin a transaction')
    await expect(outer).resolves.toBe('outer')

    expect(titles()).toEqual(['original', 'outer-a', 'outer-b'])
  })
})
