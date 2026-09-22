import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Model } from '../src/Model'
import { SoftDeletes } from '../src/SoftDeletes'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'
import { sqliteWriteFixture, postgresWriteFixture, mysqlWriteFixture, type WriteFixture } from './write-contract-fixtures'

type EntryRecord = { id: number; tenant: number; name: string; deletedAt: Date | null }

function writeContract(name: string, factory: () => WriteFixture | Promise<WriteFixture>, enabled = true): void {
  const suite = enabled ? describe : describe.skip
  suite(`${name} write contract`, () => {
    let fixture: WriteFixture
    class Entry extends Model<EntryRecord> {
      static override fillable = ['tenant', 'name']
      static override mutators = { name: (value: unknown) => `${String(value)}!` }
    }
    class SoftEntry extends SoftDeletes(Entry) {}

    beforeAll(async () => {
      fixture = await factory()
      Object.defineProperty(Entry, 'table', { value: fixture.table, configurable: true })
    })
    beforeEach(async () => {
      DrizzleAdapter.configure(fixture.db)
      Entry.removeGlobalScope('tenant')
      await fixture.clear()
      await Entry.forceCreate({ id: 1, tenant: 1, name: 'one' })
      await Entry.forceCreate({ id: 2, tenant: 2, name: 'two' })
    })
    afterAll(async () => { await fixture?.close() })

    it('applies write transforms once through model and builder entry points', async () => {
      await Entry.update({ id: 1 }, { name: 'model' })
      await Entry.where({ id: 2 }).update({ name: 'builder' })
      expect((await Entry.newQuery().orderBy('id').get()).map((entry) => entry.name)).toEqual(['model!', 'builder!'])
    })

    it('enforces fillable fields through both entry points', async () => {
      await expect(Entry.update({ id: 1 }, { deletedAt: new Date() })).rejects.toThrow()
      await expect(Entry.where({ id: 1 }).update({ deletedAt: new Date() })).rejects.toThrow()
      expect((await Entry.find(1))?.deletedAt).toBeNull()
    })

    it('keeps tenant scopes on model and builder updates and deletes', async () => {
      Entry.addGlobalScope('tenant', (query) => query.where('tenant', 1))
      await Entry.update({}, { name: 'scoped' })
      await Entry.newQuery().forceUpdate({ name: 'builder' })
      await Entry.delete({ id: 2 })
      await Entry.where({ id: 2 }).delete()
      Entry.removeGlobalScope('tenant')
      expect((await Entry.newQuery().orderBy('id').get()).map((entry) => entry.name)).toEqual(['builder!', 'two!'])
    })

    it('rejects dropped filters and unsupported write pagination before mutation', async () => {
      await expect(Entry.update({ id: undefined }, { name: 'wrong' })).rejects.toThrow()
      await expect(Entry.where({ id: undefined }).delete()).rejects.toThrow()
      await expect(Entry.newQuery().limit(1).delete()).rejects.toThrow()
      expect(await Entry.newQuery().count()).toBe(2)
    })

    it('shares soft-delete semantics while preserving explicit physical deletion', async () => {
      await SoftEntry.delete({ id: 1 })
      await SoftEntry.where({ id: 2 }).delete()
      expect(await SoftEntry.newQuery().count()).toBe(0)
      expect(await SoftEntry.withTrashed().count()).toBe(2)
      await SoftEntry.restore({ id: 1 })
      await SoftEntry.forceDelete({ id: 2 })
      expect((await SoftEntry.withTrashed().get()).map((entry) => entry.id)).toEqual([1])
    })

    it('rolls back writes from every entry point in one transaction', async () => {
      await expect(Entry.transaction(async () => {
        await Entry.update({ id: 1 }, { name: 'temporary' })
        await Entry.where({ id: 2 }).delete()
        throw new Error('rollback')
      })).rejects.toThrow('rollback')
      expect((await Entry.newQuery().orderBy('id').get()).map((entry) => entry.name)).toEqual(['one!', 'two!'])
    })
  })
}

writeContract('SQLite', sqliteWriteFixture)
writeContract('PostgreSQL', () => postgresWriteFixture(process.env.POSTGRES_URL!), Boolean(process.env.POSTGRES_URL))
writeContract('MySQL', () => mysqlWriteFixture(process.env.MYSQL_URL!), Boolean(process.env.MYSQL_URL))
