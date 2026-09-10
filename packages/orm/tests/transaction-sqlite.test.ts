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

  it('should run a nested transaction inside the open one and commit both', async () => {
    // Raced rather than left to the suite timeout: a nested call that opened its
    // own transaction would queue behind the one it runs inside and hang.
    const deadlock = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('queued behind its own transaction')), 2000)
    })

    const nested = Post.transaction(async (outerTrx, txPost) => {
      await txPost.create({ title: 'outer' })
      return Post.transaction(async (innerTrx, innerPost) => {
        await innerPost.create({ title: 'nested' })
        return innerTrx === outerTrx
      })
    })

    await expect(Promise.race([nested, deadlock])).resolves.toBe(true)
    expect(titles()).toEqual(['original', 'outer', 'nested'])
  })

  it('should reuse the open transaction for a nested one opened before the outer callback awaits anything', async () => {
    const deadlock = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('queued behind its own transaction')), 2000)
    })

    const nested = Post.transaction(async () => {
      await Post.transaction(async (_inner, innerPost) => {
        await innerPost.create({ title: 'nested' })
      })
    })

    await expect(Promise.race([nested, deadlock])).resolves.toBeUndefined()
    expect(titles()).toEqual(['original', 'nested'])
  })

  it('should roll back the outer transaction when the nested one throws', async () => {
    await expect(
      Post.transaction(async (_trx, txPost) => {
        await txPost.create({ title: 'outer' })
        await Post.transaction(async (_inner, innerPost) => {
          await innerPost.create({ title: 'nested' })
          throw new Error('boom')
        })
      }),
    ).rejects.toThrow('boom')

    expect(titles()).toEqual(['original'])
  })

  it('should queue a transaction that begins while another awaits non-database work', async () => {
    // The shape a scaffolded app hits first: `await hash(password)` inside a
    // signup transaction, with a second request arriving during it. Unrelated to
    // the open transaction, so it waits rather than being refused for nesting.
    const open = Post.transaction(async (_trx, txPost) => {
      await txPost.create({ title: 'open-a' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      await txPost.create({ title: 'open-b' })
      return 'open'
    })

    await new Promise((resolve) => setTimeout(resolve, 1))
    const arriving = Post.transaction(async (_trx, txPost) => {
      await txPost.create({ title: 'arriving' })
      return 'arriving'
    })

    await expect(open).resolves.toBe('open')
    await expect(arriving).resolves.toBe('arriving')

    expect(titles()).toEqual(['original', 'open-a', 'open-b', 'arriving'])
  })

  it('should reuse the open transaction for a nested one opened after the outer callback awaits non-database work', async () => {
    // Nesting is an async-context fact, not a timing one: the outer callback has
    // crossed a timer here, which is exactly where an arrival-order rule loses it.
    await Post.transaction(async (_trx, txPost) => {
      await txPost.create({ title: 'outer' })
      await new Promise((resolve) => setTimeout(resolve, 5))
      await Post.transaction(async (_inner, innerPost) => {
        await innerPost.create({ title: 'nested' })
      })
    })

    expect(titles()).toEqual(['original', 'outer', 'nested'])
  })

  it('should route a model call without { trx } to the open transaction', async () => {
    await expect(
      Post.transaction(async () => {
        await Post.create({ title: 'ambient' })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(titles()).toEqual(['original'])
  })
})
