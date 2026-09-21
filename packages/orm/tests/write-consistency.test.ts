import { describe, expect, it } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Model } from '../src/Model'
import { SoftDeletes } from '../src/SoftDeletes'
import { useSqlite } from './sqlite-fixture'

const table = sqliteTable('records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
})

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('write consistency on SQLite', () => {
  const sqlite = useSqlite('CREATE TABLE records(id integer primary key autoincrement, title text not null, deleted_at integer)')
  class Record extends Model<typeof table.$inferSelect> { static override table = table }
  class SoftRecord extends SoftDeletes(Record) {}

  it('keeps unrelated reads and writes outside a rolling-back transaction', async () => {
    const entered = barrier()
    const release = barrier()
    const transaction = Record.transaction(async () => {
      await Record.create({ title: 'rolled back' })
      entered.resolve()
      await release.promise
      throw new Error('rollback')
    })
    await entered.promise
    let written = false
    const write = Record.create({ title: 'kept' }).then(() => { written = true })
    const read = Record.all()
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(written).toBe(false)
    } finally { release.resolve() }
    await expect(transaction).rejects.toThrow('rollback')
    await write
    expect((await read).some((row) => row.title === 'rolled back')).toBe(false)
    expect(sqlite().query('SELECT title FROM records').all()).toEqual([{ title: 'kept' }])
  })

  it('rejects limited, offset, and ordered bulk writes without changing rows', async () => {
    await Record.create({ title: 'first' })
    await Record.create({ title: 'second' })
    for (const query of [Record.newQuery().limit(1), Record.newQuery().offset(1), Record.newQuery().orderBy('id')]) {
      await expect(query.delete()).rejects.toThrow('Bulk writes do not support')
      await expect(query.update({ title: 'wrong' })).rejects.toThrow('Bulk writes do not support')
    }
    expect((await Record.all()).map((row) => row.title)).toEqual(['first', 'second'])
  })

  it('soft deletes through builders while forceDelete remains physical', async () => {
    const row = await SoftRecord.create({ title: 'recoverable' })
    await SoftRecord.where({ id: row.id }).delete()
    expect(await SoftRecord.find(row.id)).toBeNull()
    const trashed = await SoftRecord.withTrashed().where({ id: row.id }).first()
    expect(trashed?.deletedAt).toBeInstanceOf(Date)
    await SoftRecord.restore({ id: row.id })
    expect(await SoftRecord.find(row.id)).not.toBeNull()
    await SoftRecord.forceDelete({ id: row.id })
    expect(await SoftRecord.withTrashed().where({ id: row.id }).first()).toBeNull()
  })
})
