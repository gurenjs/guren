import { beforeEach, describe, expect, it } from 'bun:test'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

type UserRecord = { id: number; name: string; email: string | null }

function createMockTable() {
  return {
    id: { name: 'id', __column: true },
    name: { name: 'name', __column: true },
    email: { name: 'email', __column: true },
  }
}

function createMockDatabase(options: {
  records?: UserRecord[]
  supportsUpdate?: boolean
  supportsDelete?: boolean
  useGetMethod?: boolean
  supportsTransaction?: boolean
} = {}) {
  const { records = [], supportsUpdate = true, supportsDelete = true, useGetMethod = false, supportsTransaction = true } = options
  let store = [...records]
  let nextId = records.length + 1

  const createSelectChain = (filtered: UserRecord[]) => {
    let result = [...filtered]
    let whereApplied = false
    let orderApplied = false

    const chain: Record<string, unknown> = {
      where: (clause: unknown) => {
        whereApplied = true
        return chain
      },
      orderBy: (...clauses: unknown[]) => {
        orderApplied = true
        return chain
      },
      limit: (value: number) => {
        result = result.slice(0, value)
        return chain
      },
      offset: (value: number) => {
        result = result.slice(value)
        return chain
      },
    }

    if (useGetMethod) {
      chain.get = async () => result[0] ?? null
    } else {
      chain.all = async () => result
    }

    return chain
  }

  const db = {
    select: (selection?: Record<string, unknown>) => ({
      from: (table: unknown) => createSelectChain(store),
    }),
    insert: (table: unknown) => ({
      values: (record: Record<string, unknown>) => ({
        returning: async () => {
          const newRecord = { ...record, id: nextId++ } as UserRecord
          store.push(newRecord)
          return [newRecord]
        },
      }),
    }),
    update: supportsUpdate
      ? (table: unknown) => {
          let updateData: Record<string, unknown> = {}
          let whereClause: unknown

          const chain = {
            set: (data: Record<string, unknown>) => {
              updateData = data
              return chain
            },
            where: (clause: unknown) => {
              whereClause = clause
              return chain
            },
            returning: async () => {
              const record = store[0]
              if (record) {
                Object.assign(record, updateData)
                return [record]
              }
              return []
            },
          }

          return chain
        }
      : undefined,
    delete: supportsDelete
      ? (table: unknown) => {
          let whereClause: unknown

          const chain = {
            where: (clause: unknown) => {
              whereClause = clause
              return chain
            },
            returning: async () => {
              if (store.length > 0) {
                const deleted = store.shift()
                return deleted ? [deleted] : []
              }
              return []
            },
          }

          return chain
        }
      : undefined,
    transaction: supportsTransaction
      ? async <TResult>(callback: (trx: unknown) => Promise<TResult>): Promise<TResult> => callback(db)
      : undefined,
  }

  return {
    db,
    getStore: () => [...store],
    setStore: (newStore: UserRecord[]) => {
      store = [...newStore]
    },
  }
}

const adapter = DrizzleAdapter as typeof DrizzleAdapter & {
  update: NonNullable<typeof DrizzleAdapter.update>
  delete: NonNullable<typeof DrizzleAdapter.delete>
  count: NonNullable<typeof DrizzleAdapter.count>
}

describe('DrizzleAdapter', () => {
  beforeEach(() => {
    DrizzleAdapter.configure(undefined as never)
  })

  describe('configure and getDatabase', () => {
    it('throws error when database is not configured', () => {
      expect(() => DrizzleAdapter.getDatabase()).toThrow(
        'DrizzleAdapter: database has not been configured. Call DrizzleAdapter.configure(db).',
      )
    })

    it('returns configured database', () => {
      const { db } = createMockDatabase()
      DrizzleAdapter.configure(db as never)

      const result = DrizzleAdapter.getDatabase()
      expect(result).toBe(db)
    })
  })

  describe('findMany', () => {
    it('returns all records when no options provided', async () => {
      const records = [
        { id: 1, name: 'Alice', email: 'alice@example.com' },
        { id: 2, name: 'Bob', email: 'bob@example.com' },
      ]
      const { db } = createMockDatabase({ records })
      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await DrizzleAdapter.findMany(table)

      expect(result).toEqual(records)
    })

    it('applies limit and offset', async () => {
      const records = [
        { id: 1, name: 'Alice', email: 'alice@example.com' },
        { id: 2, name: 'Bob', email: 'bob@example.com' },
        { id: 3, name: 'Charlie', email: 'charlie@example.com' },
      ]
      const { db } = createMockDatabase({ records })
      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      // DrizzleAdapter applies limit before offset, so:
      // limit(2) -> [Alice, Bob], then offset(1) -> [Bob]
      const result = await DrizzleAdapter.findMany(table, { limit: 2, offset: 1 })

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Bob')
    })

    it('works with get() method instead of all()', async () => {
      const records = [{ id: 1, name: 'Alice', email: 'alice@example.com' }]
      const { db } = createMockDatabase({ records, useGetMethod: true })
      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await DrizzleAdapter.findMany(table)

      expect(result).toEqual([records[0]])
    })
  })

  describe('findUnique', () => {
    it('returns single record matching where clause', async () => {
      const records = [
        { id: 1, name: 'Alice', email: 'alice@example.com' },
        { id: 2, name: 'Bob', email: 'bob@example.com' },
      ]
      const { db } = createMockDatabase({ records })
      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await DrizzleAdapter.findUnique(table, { id: 1 })

      expect(result).toEqual(records[0])
    })

    it('returns null when no record found', async () => {
      const { db } = createMockDatabase({ records: [] })
      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await DrizzleAdapter.findUnique(table, { id: 999 })

      expect(result).toBeNull()
    })

    it('works with get() method', async () => {
      const records = [{ id: 1, name: 'Alice', email: 'alice@example.com' }]
      const { db } = createMockDatabase({ records, useGetMethod: true })
      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await DrizzleAdapter.findUnique(table, { id: 1 })

      expect(result).toEqual(records[0])
    })
  })

  describe('create', () => {
    it('creates new record with returning', async () => {
      const { db, getStore } = createMockDatabase()
      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await DrizzleAdapter.create(table, { name: 'Alice', email: 'alice@example.com' })

      expect(result).toEqual({ id: 1, name: 'Alice', email: 'alice@example.com' })
      expect(getStore()).toHaveLength(1)
    })

    it('creates multiple records sequentially', async () => {
      const { db, getStore } = createMockDatabase()
      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      await DrizzleAdapter.create(table, { name: 'Alice', email: 'alice@example.com' })
      await DrizzleAdapter.create(table, { name: 'Bob', email: 'bob@example.com' })

      const store = getStore()
      expect(store).toHaveLength(2)
      expect(store[0].id).toBe(1)
      expect(store[1].id).toBe(2)
    })
  })

  describe('update', () => {
    it('updates existing record', async () => {
      const records = [{ id: 1, name: 'Alice', email: 'alice@example.com' }]
      const { db } = createMockDatabase({ records })
      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await adapter.update(table, { id: 1 }, { name: 'Updated Alice' })

      expect((result as unknown as { name: string }).name).toBe('Updated Alice')
    })

    it('throws error when database does not support updates', async () => {
      const { db } = createMockDatabase({ supportsUpdate: false })
      DrizzleAdapter.configure(db as never)

      const table = createMockTable()

      await expect(adapter.update(table, { id: 1 }, { name: 'Test' })).rejects.toThrow(
        'DrizzleAdapter: configured database does not support updates.',
      )
    })
  })

  describe('delete', () => {
    it('deletes existing record', async () => {
      const records = [{ id: 1, name: 'Alice', email: 'alice@example.com' }]
      const { db, getStore } = createMockDatabase({ records })
      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      await adapter.delete(table, { id: 1 })

      expect(getStore()).toHaveLength(0)
    })

    it('throws error when database does not support deletes', async () => {
      const { db } = createMockDatabase({ supportsDelete: false })
      DrizzleAdapter.configure(db as never)

      const table = createMockTable()

      await expect(adapter.delete(table, { id: 1 })).rejects.toThrow(
        'DrizzleAdapter: configured database does not support deletes.',
      )
    })
  })

  describe('count', () => {
    it('returns count of all records', async () => {
      const records = [
        { id: 1, name: 'Alice', email: 'alice@example.com' },
        { id: 2, name: 'Bob', email: 'bob@example.com' },
      ]

      const db = {
        select: (selection?: Record<string, unknown>) => ({
          from: (table: unknown) => ({
            where: () => ({
              all: async () => [{ value: 2 }],
            }),
            all: async () => [{ value: 2 }],
          }),
        }),
      }

      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await adapter.count(table)

      expect(result).toBe(2)
    })

    it('handles bigint count values', async () => {
      const db = {
        select: (selection?: Record<string, unknown>) => ({
          from: (table: unknown) => ({
            all: async () => [{ value: BigInt(100) }],
          }),
        }),
      }

      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await adapter.count(table)

      expect(result).toBe(100)
    })

    it('returns 0 for empty results', async () => {
      const db = {
        select: (selection?: Record<string, unknown>) => ({
          from: (table: unknown) => ({
            all: async () => [],
          }),
        }),
      }

      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await adapter.count(table)

      expect(result).toBe(0)
    })

    it('returns 0 for NaN values', async () => {
      const db = {
        select: (selection?: Record<string, unknown>) => ({
          from: (table: unknown) => ({
            all: async () => [{ value: 'not a number' }],
          }),
        }),
      }

      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await adapter.count(table)

      expect(result).toBe(0)
    })
  })

  describe('resolveWhere edge cases', () => {
    it('handles undefined where clause', async () => {
      const records = [{ id: 1, name: 'Alice', email: 'alice@example.com' }]
      const { db } = createMockDatabase({ records })
      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await DrizzleAdapter.findMany(table, { where: undefined })

      expect(result).toEqual(records)
    })

    it('filters out undefined values in where clause', async () => {
      const records = [{ id: 1, name: 'Alice', email: 'alice@example.com' }]
      const { db } = createMockDatabase({ records })
      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await DrizzleAdapter.findMany(table, {
        where: { id: 1, name: undefined } as never,
      })

      expect(result).toEqual(records)
    })
  })

  describe('promise-like result handling', () => {
    it('handles promise-like select results for findMany', async () => {
      const records = [{ id: 1, name: 'Alice', email: 'alice@example.com' }]

      const db = {
        select: () => ({
          from: () => Promise.resolve(records),
        }),
      }

      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await DrizzleAdapter.findMany(table)

      expect(result).toEqual(records)
    })

    it('handles promise-like select results for findUnique', async () => {
      const records = [{ id: 1, name: 'Alice', email: 'alice@example.com' }]

      const db = {
        select: () => ({
          from: () => Promise.resolve(records),
        }),
      }

      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await DrizzleAdapter.findUnique(table, { id: 1 })

      expect(result).toEqual(records[0])
    })

    it('handles promise-like mutation results', async () => {
      const db = {
        select: () => ({ from: () => ({ all: async () => [] }) }),
        insert: () => ({
          values: () => Promise.resolve({ id: 1, name: 'Alice' }),
        }),
      }

      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await DrizzleAdapter.create(table, { name: 'Alice' })

      expect(result).toEqual({ id: 1, name: 'Alice' })
    })

    it('prefers returning() over thenable resolution for create', async () => {
      const expectedRecord = { id: 1, name: 'Alice', email: 'alice@example.com' }

      const db = {
        select: () => ({ from: () => ({ all: async () => [] }) }),
        insert: () => ({
          values: () => {
            const obj = {
              // Thenable — would resolve to RunResult without the fix
              then: (resolve: (v: unknown) => void) => resolve({ changes: 1, lastInsertRowid: 1 }),
              // returning() — should be preferred and return the actual record
              returning: async () => [expectedRecord],
            }
            return obj
          },
        }),
      }

      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await DrizzleAdapter.create(table, { name: 'Alice', email: 'alice@example.com' })

      expect(result).toEqual(expectedRecord)
    })

    it('prefers returning() over thenable resolution for update', async () => {
      const expectedRecord = { id: 1, name: 'Updated', email: 'alice@example.com' }

      const db = {
        select: () => ({ from: () => ({ all: async () => [] }) }),
        update: () => ({
          set: () => ({
            where: () => ({
              then: (resolve: (v: unknown) => void) => resolve({ changes: 1 }),
              returning: async () => [expectedRecord],
            }),
          }),
        }),
      }

      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await adapter.update(table, { id: 1 }, { name: 'Updated' })

      expect((result as unknown as { name: string }).name).toBe('Updated')
    })

    it('prefers returning() over thenable resolution for delete', async () => {
      const expectedRecord = { id: 1, name: 'Alice', email: 'alice@example.com' }

      const db = {
        select: () => ({ from: () => ({ all: async () => [] }) }),
        delete: () => ({
          where: () => ({
            then: (resolve: (v: unknown) => void) => resolve({ changes: 1 }),
            returning: async () => [expectedRecord],
          }),
        }),
      }

      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await adapter.delete(table, { id: 1 })

      expect(result).toEqual(expectedRecord)
    })

    it('does not execute update twice when returning() yields no rows', async () => {
      let executions = 0

      const db = {
        select: () => ({ from: () => ({ all: async () => [] }) }),
        update: () => ({
          set: () => ({
            where: () => ({
              then: (resolve: (v: unknown) => void) => {
                executions += 1
                resolve({ changes: 0 })
              },
              returning: async () => {
                executions += 1
                return []
              },
            }),
          }),
        }),
      }

      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await adapter.update(table, { id: 1 }, { name: 'Updated' })

      expect(result).toBeUndefined()
      expect(executions).toBe(1)
    })

    it('does not execute delete twice when returning() yields no rows', async () => {
      let executions = 0

      const db = {
        select: () => ({ from: () => ({ all: async () => [] }) }),
        delete: () => ({
          where: () => ({
            then: (resolve: (v: unknown) => void) => {
              executions += 1
              resolve({ changes: 0 })
            },
            returning: async () => {
              executions += 1
              return []
            },
          }),
        }),
      }

      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await adapter.delete(table, { id: 1 })

      expect(result).toBeUndefined()
      expect(executions).toBe(1)
    })

    it('handles run() method for mutations', async () => {
      const db = {
        select: () => ({ from: () => ({ all: async () => [] }) }),
        insert: () => ({
          values: () => ({
            run: async () => ({ lastInsertRowid: 1 }),
          }),
        }),
      }

      DrizzleAdapter.configure(db as never)

      const table = createMockTable()
      const result = await DrizzleAdapter.create(table, { name: 'Alice' })

      expect(result).toEqual({ lastInsertRowid: 1 })
    })
  })

  describe('transaction', () => {
    it('delegates transaction callback to database transaction', async () => {
      const { db } = createMockDatabase()
      DrizzleAdapter.configure(db as never)

      const runTransaction = DrizzleAdapter.transaction as NonNullable<typeof DrizzleAdapter.transaction>
      const result = await runTransaction(async (trx) => {
        expect(trx).toBe(db)
        return 'ok'
      })

      expect(result).toBe('ok')
    })

    it('throws when database does not support transactions', async () => {
      const { db } = createMockDatabase({ supportsTransaction: false })
      DrizzleAdapter.configure(db as never)

      const runTransaction = DrizzleAdapter.transaction as NonNullable<typeof DrizzleAdapter.transaction>
      await expect(runTransaction(async () => 'ok')).rejects.toThrow(
        'DrizzleAdapter: configured database does not support transactions.',
      )
    })
  })
})
