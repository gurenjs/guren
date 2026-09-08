import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Model } from '../src/Model'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

// Integration test against the real bun:sqlite driver, whose drizzle
// `transaction()` COMMITs on whatever the callback returns without awaiting it.
// Only a real driver can show whether a write survived a throw, which is why the
// SQL-shape tests next door pass whether or not the transaction is atomic. The
// adapter's queue is module-level; `beforeEach`'s `configure()` is what resets it.

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

  it('should serialize transactions started concurrently', async () => {
    const [first, second] = await Promise.all([
      Post.transaction(async (_trx, txPost) => {
        await txPost.create({ title: 'first-a' })
        await txPost.create({ title: 'first-b' })
        return 'first'
      }),
      Post.transaction(async (_trx, txPost) => {
        await txPost.create({ title: 'second' })
        return 'second'
      }),
    ])

    expect([first, second]).toEqual(['first', 'second'])
    expect(titles()).toEqual(['original', 'first-a', 'first-b', 'second'])
  })

  it('should roll back only the failing one of two concurrent transactions', async () => {
    const [kept, discarded] = await Promise.allSettled([
      Post.transaction(async (_trx, txPost) => {
        await txPost.create({ title: 'kept' })
      }),
      Post.transaction(async (_trx, txPost) => {
        await txPost.create({ title: 'discarded' })
        throw new Error('boom')
      }),
    ])

    expect(kept.status).toBe('fulfilled')
    expect(discarded.status).toBe('rejected')
    expect(titles()).toEqual(['original', 'kept'])
  })

  it('should refuse a nested transaction without disturbing the open one', async () => {
    await expect(
      Post.transaction(async (_trx, txPost) => {
        await txPost.create({ title: 'outer' })
        await Post.transaction(async (_inner, innerPost) => {
          await innerPost.create({ title: 'nested' })
        })
      }),
    ).rejects.toThrow('cannot begin a transaction while one is already open')

    // The outer transaction saw the nested call's error and rolled back with it.
    expect(titles()).toEqual(['original'])
  })

  it('should refuse a nested transaction opened before the outer callback awaits anything', async () => {
    // Raced rather than left to the suite timeout: were the flag set any later
    // than the BEGIN it follows, this call would queue behind the transaction it
    // is running inside and hang, which reads as a neighbouring test failing.
    const deadlock = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('queued behind its own transaction')), 2000)
    })

    const nested = Post.transaction(async () => {
      await Post.transaction(async (_inner, innerPost) => {
        await innerPost.create({ title: 'nested' })
      })
    })

    await expect(Promise.race([nested, deadlock])).rejects.toThrow(
      'cannot begin a transaction while one is already open',
    )
    expect(titles()).toEqual(['original'])
  })

  it('should refuse a transaction that begins while another awaits non-database work', async () => {
    const open = Post.transaction(async (_trx, txPost) => {
      await txPost.create({ title: 'open-a' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      await txPost.create({ title: 'open-b' })
      return 'open'
    })

    await new Promise((resolve) => setTimeout(resolve, 1))
    const arriving = Post.transaction(async (_trx, txPost) => {
      await txPost.create({ title: 'arriving' })
    })

    await expect(arriving).rejects.toThrow('cannot begin a transaction while one is already open')
    await expect(open).resolves.toBe('open')

    expect(titles()).toEqual(['original', 'open-a', 'open-b'])
  })
})
