import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Model } from '../src/Model'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

const table = sqliteTable('items', { id: integer('id').primaryKey(), name: text('name').notNull() })
class Item extends Model<typeof table.$inferSelect> { static override table = table }

function fixture() {
  const client = new Database(':memory:')
  client.exec('CREATE TABLE items (id integer primary key, name text not null)')
  return { client, db: drizzle({ client }) }
}

describe('connection-owned execution state', () => {
  it('retains an open connection queue when the default changes away and back', async () => {
    const first = fixture()
    const second = fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    DrizzleAdapter.configure(first.db as never)
    const transaction = Item.transaction(async () => {
      await Item.create({ id: 1, name: 'rollback' })
      entered.resolve()
      await release.promise
      throw new Error('rollback')
    }).catch((error: unknown) => error)
    let unrelated: Promise<void> | undefined
    try {
      await entered.promise
      DrizzleAdapter.configure(second.db as never)
      await Item.transaction(async () => { await Item.create({ id: 2, name: 'second' }) })
      DrizzleAdapter.configure(first.db as never)
      let completed = false
      unrelated = Item.create({ id: 3, name: 'kept' }).then(() => { completed = true })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const queuedBehindTransaction = !completed
      release.resolve()
      expect(queuedBehindTransaction).toBe(true)
      expect(await transaction).toBeInstanceOf(Error)
      await unrelated
      expect(first.client.query('SELECT name FROM items').all()).toEqual([{ name: 'kept' }])
      expect(second.client.query('SELECT name FROM items').all()).toEqual([{ name: 'second' }])
    } finally {
      release.resolve()
      await transaction
      await unrelated?.catch(() => undefined)
      first.client.close()
      second.client.close()
    }
  })

  it('keeps the transaction owner after default reconfiguration', async () => {
    const first = fixture()
    const second = fixture()
    try {
      DrizzleAdapter.configure(first.db as never)
      await Item.transaction(async () => {
        DrizzleAdapter.configure(second.db as never)
        expect(DrizzleAdapter.getDatabase() as unknown).toBe(first.db)
        await Item.transaction(async () => { await Item.create({ id: 1, name: 'owned' }) })
      })
      expect(DrizzleAdapter.getDatabase() as unknown).toBe(second.db)
      expect(first.client.query('SELECT name FROM items').all()).toEqual([{ name: 'owned' }])
      expect(second.client.query('SELECT name FROM items').all()).toEqual([])
    } finally {
      first.client.close()
      second.client.close()
    }
  })
})
