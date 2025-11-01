import { describe, expect, it } from 'bun:test'
import { Model, type ORMAdapter, type PlainObject, type WhereClause } from '../src/Model'

type UserRecord = { id: number; name: string; team?: string }

function createAdapter(records: UserRecord[] = []): { adapter: ORMAdapter; snapshot: () => UserRecord[] } {
  let nextId = records.length + 1
  const store = [...records]

  function matches(where?: WhereClause) {
    if (!where) {
      return () => true
    }

    return (record: UserRecord) => Object.entries(where).every(([key, value]) => (record as PlainObject)[key] === value)
  }

  const adapter: ORMAdapter = {
    async findMany<TRecord = PlainObject>(table: unknown, where?: WhereClause): Promise<TRecord[]> {
      expect(table).toBe('users')
      return store.filter(matches(where)).map((record) => ({ ...record })) as unknown as TRecord[]
    },

    async findUnique<TRecord = PlainObject>(table: unknown, where: WhereClause): Promise<TRecord | null> {
      expect(table).toBe('users')
      const record = store.find(matches(where))
      return (record ? { ...record } : null) as unknown as TRecord | null
    },

    async create<TRecord = PlainObject>(table: unknown, data: PlainObject): Promise<TRecord> {
      expect(table).toBe('users')
      const record = { ...(data as UserRecord), id: nextId++ } as UserRecord
      store.push(record)
      return { ...record } as unknown as TRecord
    },

    async update<TRecord = PlainObject>(table: unknown, where: WhereClause, data: PlainObject): Promise<TRecord> {
      expect(table).toBe('users')
      const record = store.find(matches(where))

      if (!record) {
        throw new Error('Record not found')
      }

      Object.assign(record, data)
      return { ...record } as unknown as TRecord
    },

    async delete(table: unknown, where: WhereClause): Promise<number> {
      expect(table).toBe('users')
      const index = store.findIndex(matches(where))
      if (index === -1) {
        return 0
      }

      store.splice(index, 1)
      return 1
    },
  }

  return {
    adapter,
    snapshot: () => store.map((record) => ({ ...record })),
  }
}

describe('Model', () => {
  it('delegates CRUD helpers to the configured adapter', async () => {
    class User extends Model<UserRecord> {
      static table = 'users'
    }

    const { adapter, snapshot } = createAdapter([{ id: 1, name: 'Daiki', team: 'core' }])
    User.useAdapter(adapter)

    expect(await User.all()).toEqual(snapshot())
    expect(await User.find(1)).toEqual({ id: 1, name: 'Daiki', team: 'core' })
    expect(await User.where({ team: 'core' })).toEqual([{ id: 1, name: 'Daiki', team: 'core' }])

    const created = (await User.create({ name: 'Asuka', team: 'infra' })) as UserRecord
    expect(created.id).toBeGreaterThan(1)
    expect(created.name).toBe('Asuka')

    const updated = (await User.update({ id: created.id }, { team: 'platform' })) as UserRecord
    expect(updated).toEqual({ id: created.id, name: 'Asuka', team: 'platform' })

    const deletedCount = await User.delete({ id: 1 })
    expect(deletedCount).toBe(1)
  })

  it('throws a descriptive error when the table property is missing', async () => {
    class Untethered extends Model<UserRecord> {}

    await expect(Untethered.all()).rejects.toThrow('Untethered.table must be defined before using the model.')
  })
})
