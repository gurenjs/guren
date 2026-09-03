import { describe, it, expect, beforeEach } from 'bun:test'
import { QueryBuilder, type WhereCondition, type ORMAdapterAdvanced } from '../src/QueryBuilder'
import { Model, type ORMAdapter, type PlainObject, type FindManyOptions } from '../src/Model'
import { ModelNotFoundException } from '../src/ModelNotFoundException'

type TestRecord = {
  id: number
  name: string
  email: string | null
  role: string
  score: number
}

function createAdvancedAdapter(records: TestRecord[]): ORMAdapterAdvanced {
  function evaluateCondition(record: TestRecord, condition: WhereCondition): boolean {
    if (condition.type === 'group') {
      if (condition.boolean === 'or') {
        return condition.conditions.some((c) => evaluateCondition(record, c))
      }
      return condition.conditions.every((c) => evaluateCondition(record, c))
    }

    const val = (record as PlainObject)[condition.field]
    switch (condition.operator) {
      case '=': return val === condition.value
      case '!=': return val !== condition.value
      case '>': return (val as number) > (condition.value as number)
      case '<': return (val as number) < (condition.value as number)
      case '>=': return (val as number) >= (condition.value as number)
      case '<=': return (val as number) <= (condition.value as number)
      case 'like': return typeof val === 'string' && new RegExp(String(condition.value).replace(/%/g, '.*')).test(val)
      case 'in': return Array.isArray(condition.value) && condition.value.includes(val)
      case 'not in': return Array.isArray(condition.value) && !condition.value.includes(val)
      case 'is null': return val == null
      case 'is not null': return val != null
      default: return false
    }
  }

  function filterRecords(conditions: WhereCondition[]): TestRecord[] {
    return records.filter((record) => {
      // Evaluate conditions sequentially: simple/AND are AND-ed, OR groups break with OR
      let result = true
      for (const c of conditions) {
        if (c.type === 'group' && c.boolean === 'or') {
          // OR: previous result OR this group's conditions
          const groupResult = c.conditions.some((sub) => evaluateCondition(record, sub))
          result = result || groupResult
        } else {
          // AND: accumulate
          result = result && evaluateCondition(record, c)
        }
      }
      return result
    })
  }

  return {
    async findMany<TRecord extends PlainObject>(table: unknown, options?: FindManyOptions<TRecord>) {
      let results = [...records]
      if (options?.where) {
        results = results.filter((r) =>
          Object.entries(options.where as PlainObject).every(
            ([k, v]) => (r as PlainObject)[k] === v,
          ),
        )
      }
      return results as unknown as TRecord[]
    },
    async findUnique() { return null },
    async findManyAdvanced<TRecord extends PlainObject>(
      _table: unknown,
      conditions: WhereCondition[],
      options: { orderBy?: any; limit?: number; offset?: number; select?: readonly string[] },
    ) {
      let results = conditions.length > 0 ? filterRecords(conditions) : [...records]

      if (options.orderBy) {
        results.sort((a: any, b: any) => {
          for (const { column, direction } of options.orderBy!) {
            if (a[column] < b[column]) return direction === 'asc' ? -1 : 1
            if (a[column] > b[column]) return direction === 'asc' ? 1 : -1
          }
          return 0
        })
      }

      if (options.offset) results = results.slice(options.offset)
      if (options.limit) results = results.slice(0, options.limit)

      if (options.select) {
        results = results.map((r) => {
          const obj: any = {}
          for (const f of options.select!) obj[f] = (r as any)[f]
          return obj
        })
      }

      return results as unknown as TRecord[]
    },
    async countAdvanced(_table: unknown, conditions: WhereCondition[]) {
      return conditions.length > 0 ? filterRecords(conditions).length : records.length
    },
    async updateAdvanced(_table: unknown, conditions: WhereCondition[], data: PlainObject) {
      const targets = filterRecords(conditions)
      for (const t of targets) Object.assign(t, data)
      return targets[0] as unknown as PlainObject
    },
    async deleteAdvanced(_table: unknown, conditions: WhereCondition[]) {
      const targets = filterRecords(conditions)
      for (const t of targets) {
        const idx = records.indexOf(t)
        if (idx >= 0) records.splice(idx, 1)
      }
      return targets.length
    },
    // Required stubs so QueryBuilder doesn't throw "adapter does not support" errors
    async update(_table: unknown, _where: unknown, data: PlainObject) {
      return data
    },
    async delete(_table: unknown, _where: unknown) {
      return 0
    },
  } as unknown as ORMAdapterAdvanced
}

const testData: TestRecord[] = [
  { id: 1, name: 'Alice', email: 'alice@test.com', role: 'admin', score: 95 },
  { id: 2, name: 'Bob', email: 'bob@test.com', role: 'user', score: 70 },
  { id: 3, name: 'Charlie', email: null, role: 'user', score: 85 },
  { id: 4, name: 'Diana', email: 'diana@test.com', role: 'admin', score: 60 },
  { id: 5, name: 'Eve', email: null, role: 'user', score: 90 },
]

let TestModel: typeof Model
let adapter: ORMAdapterAdvanced

beforeEach(() => {
  const data = testData.map((r) => ({ ...r }))
  adapter = createAdvancedAdapter(data)

  TestModel = class extends Model<TestRecord> {
    static table = 'tests' as any
    static getAdapter() { return adapter as ORMAdapter }
    static resolveTable() { return 'tests' }
  }
})

function qb() {
  return new QueryBuilder<TestRecord>(TestModel)
}

describe('QueryBuilder', () => {
  describe('where', () => {
    it('should filter with equality', async () => {
      const results = await qb().where('role', 'admin').get()
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.role === 'admin')).toBe(true)
    })

    it('should filter with operator', async () => {
      const results = await qb().where('score', '>', 80).get()
      expect(results).toHaveLength(3)
    })

    it('should filter with object conditions', async () => {
      const results = await qb().where({ role: 'admin', name: 'Alice' }).get()
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Alice')
    })

    it('should chain multiple where calls', async () => {
      const results = await qb().where('role', 'user').where('score', '>', 80).get()
      expect(results).toHaveLength(2)
    })
  })

  describe('orWhere', () => {
    it('should add OR conditions', async () => {
      const results = await qb().where('name', 'Alice').orWhere('name', 'Bob').get()
      expect(results).toHaveLength(2)
    })

    it('should support operator form', async () => {
      const results = await qb().where('score', '>=', 90).orWhere('role', 'admin').get()
      // Alice (admin, 95), Eve (90), Diana (admin, 60)
      expect(results).toHaveLength(3)
    })

    it('should support object form', async () => {
      const results = await qb().where('name', 'Alice').orWhere({ name: 'Bob' }).get()
      expect(results).toHaveLength(2)
    })
  })

  describe('callback condition groups', () => {
    it('should AND a grouped OR with surrounding conditions', async () => {
      const results = await qb()
        .where((q) => q.where('name', 'Alice').orWhere('name', 'Bob'))
        .where('role', 'admin')
        .get()
      // (name = Alice OR name = Bob) AND role = admin — Bob is a user
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Alice')
    })

    it('should keep a preceding where out of the group OR', async () => {
      const results = await qb()
        .where('role', 'user')
        .where((q) => q.where('score', '>', 85).orWhere('name', 'Bob'))
        .get()
      // role = user AND (score > 85 OR name = Bob) — Eve and Bob
      expect(results).toHaveLength(2)
      expect(results.map((r) => r.name).sort()).toEqual(['Bob', 'Eve'])
    })

    it('should preserve sequential orWhere semantics inside a callback', async () => {
      const results = await qb()
        .where((q) => q.where('role', 'admin').where('score', '>', 90).orWhere('name', 'Eve'))
        .whereNotNull('email')
        .get()
      // ((admin AND score > 90) OR Eve) AND email NOT NULL — Eve has no email
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Alice')
    })

    it('should group a callback made only of orWhere calls', async () => {
      const results = await qb()
        .where((q) => q.orWhere('name', 'Alice').orWhere('name', 'Bob'))
        .where('role', 'admin')
        .get()
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Alice')
    })

    it('should OR a whole callback group with orWhere', async () => {
      const results = await qb()
        .where('role', 'admin')
        .orWhere((q) => q.where('role', 'user').where('score', '>=', 90))
        .get()
      // role = admin OR (role = user AND score >= 90) — Alice, Diana, Eve
      expect(results).toHaveLength(3)
      expect(results.map((r) => r.name).sort()).toEqual(['Alice', 'Diana', 'Eve'])
    })

    it('should support nesting callbacks inside callbacks', async () => {
      const results = await qb()
        .where((q) => {
          q.where('role', 'user')
          q.where((inner) => inner.where('score', '>=', 90).orWhere('name', 'Bob'))
        })
        .get()
      // role = user AND (score >= 90 OR name = Bob)
      expect(results).toHaveLength(2)
      expect(results.map((r) => r.name).sort()).toEqual(['Bob', 'Eve'])
    })

    it('should treat an empty callback as a no-op', async () => {
      const results = await qb().where(() => {}).orWhere(() => {}).get()
      expect(results).toHaveLength(5)
    })

    it('should count with grouped conditions', async () => {
      const count = await qb()
        .where((q) => q.where('name', 'Alice').orWhere('name', 'Bob'))
        .where('role', 'admin')
        .count()
      expect(count).toBe(1)
    })

    it('should not fold a preceding where into the group when the callback starts with orWhere', () => {
      // Regression pin: the outer builder's conditions must never leak into
      // the nested normalization.
      const builder = qb()
        .where('role', 'admin')
        .where((q) => q.orWhere('name', 'Alice'))
      const conditions = builder.getConditions()
      expect(conditions).toHaveLength(2)
      expect(conditions[0]).toEqual({ type: 'simple', field: 'role', operator: '=', value: 'admin' })
      expect(conditions[1]).toEqual({ type: 'simple', field: 'name', operator: '=', value: 'Alice' })
    })
  })

  describe('whereNull / whereNotNull', () => {
    it('should filter null values', async () => {
      const results = await qb().whereNull('email').get()
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.email === null)).toBe(true)
    })

    it('should filter non-null values', async () => {
      const results = await qb().whereNotNull('email').get()
      expect(results).toHaveLength(3)
      expect(results.every((r) => r.email !== null)).toBe(true)
    })
  })

  describe('whereIn / whereNotIn', () => {
    it('should filter with IN', async () => {
      const results = await qb().whereIn('id', [1, 3, 5]).get()
      expect(results).toHaveLength(3)
      expect(results.map((r) => r.id).sort()).toEqual([1, 3, 5])
    })

    it('should filter with NOT IN', async () => {
      const results = await qb().whereNotIn('id', [1, 2]).get()
      expect(results).toHaveLength(3)
      expect(results.every((r) => r.id > 2)).toBe(true)
    })

    it('should handle empty array for IN', async () => {
      const results = await qb().whereIn('id', []).get()
      expect(results).toHaveLength(0)
    })
  })

  describe('orderBy', () => {
    it('should sort ascending by default', async () => {
      const results = await qb().orderBy('score').get()
      const scores = results.map((r) => r.score)
      expect(scores).toEqual([60, 70, 85, 90, 95])
    })

    it('should sort descending', async () => {
      const results = await qb().orderBy('score', 'desc').get()
      const scores = results.map((r) => r.score)
      expect(scores).toEqual([95, 90, 85, 70, 60])
    })

    it('should support multi-column sort', async () => {
      const results = await qb().orderBy('role').orderBy('score', 'desc').get()
      expect(results[0].name).toBe('Alice') // admin, 95
      expect(results[1].name).toBe('Diana') // admin, 60
    })
  })

  describe('limit / offset', () => {
    it('should limit results', async () => {
      const results = await qb().orderBy('id').limit(2).get()
      expect(results).toHaveLength(2)
      expect(results[0].id).toBe(1)
    })

    it('should offset results', async () => {
      const results = await qb().orderBy('id').offset(3).get()
      expect(results).toHaveLength(2)
      expect(results[0].id).toBe(4)
    })

    it('should combine limit and offset', async () => {
      const results = await qb().orderBy('id').offset(1).limit(2).get()
      expect(results).toHaveLength(2)
      expect(results[0].id).toBe(2)
      expect(results[1].id).toBe(3)
    })
  })

  describe('select', () => {
    it('should return only selected fields', async () => {
      const results = await qb().select('id', 'name').get()
      expect(results).toHaveLength(5)
      const first = results[0] as any
      expect(first.id).toBeDefined()
      expect(first.name).toBeDefined()
      expect(first.email).toBeUndefined()
      expect(first.role).toBeUndefined()
    })
  })

  describe('first / firstOrFail', () => {
    it('first should return first result', async () => {
      const result = await qb().where('role', 'admin').orderBy('id').first()
      expect(result).not.toBeNull()
      expect(result!.name).toBe('Alice')
    })

    it('first should return null when no match', async () => {
      const result = await qb().where('name', 'Nobody').first()
      expect(result).toBeNull()
    })

    it('firstOrFail should throw ModelNotFoundException when no match', async () => {
      await expect(qb().where('name', 'Nobody').firstOrFail()).rejects.toThrow(ModelNotFoundException)
    })

    it('firstOrFail exception should carry statusCode 404', async () => {
      try {
        await qb().where('name', 'Nobody').firstOrFail()
        expect.unreachable('firstOrFail should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(ModelNotFoundException)
        expect((error as ModelNotFoundException).statusCode).toBe(404)
      }
    })

    it('firstOrFail should return record when match exists', async () => {
      const result = await qb().where('name', 'Alice').firstOrFail()
      expect(result.name).toBe('Alice')
    })
  })

  describe('count', () => {
    it('should count all records', async () => {
      const count = await qb().count()
      expect(count).toBe(5)
    })

    it('should count with conditions', async () => {
      const count = await qb().where('role', 'admin').count()
      expect(count).toBe(2)
    })
  })

  describe('paginate', () => {
    it('should paginate results', async () => {
      const page = await qb().orderBy('id').paginate(1, 2)
      expect(page.data).toHaveLength(2)
      expect(page.meta.total).toBe(5)
      expect(page.meta.totalPages).toBe(3)
      expect(page.meta.currentPage).toBe(1)
      expect(page.meta.hasMore).toBe(true)
      expect(page.meta.perPage).toBe(2)
    })

    it('should handle last page', async () => {
      const page = await qb().orderBy('id').paginate(3, 2)
      expect(page.data).toHaveLength(1)
      expect(page.meta.hasMore).toBe(false)
    })

    it('should clamp page beyond total', async () => {
      const page = await qb().paginate(100, 2)
      expect(page.meta.currentPage).toBeLessThanOrEqual(page.meta.totalPages)
    })
  })

  describe('update', () => {
    it('should update matching records', async () => {
      await qb().where('name', 'Alice').update({ score: 100 })
      const results = await qb().where('name', 'Alice').get()
      expect(results[0].score).toBe(100)
    })

    it('should run payloads through preparePersistencePayload overrides', async () => {
      const PreparedModel = class extends Model<TestRecord> {
        static table = 'tests' as any
        static getAdapter() { return adapter as ORMAdapter }
        static resolveTable() { return 'tests' }

        protected static override async preparePersistencePayload(data: PlainObject): Promise<PlainObject> {
          const payload = await super.preparePersistencePayload(data)
          if (typeof payload.name === 'string') {
            payload.name = payload.name.toUpperCase()
          }
          return payload
        }
      }

      await new QueryBuilder<TestRecord>(PreparedModel).where('id', 1).update({ name: 'renamed' })
      const results = await qb().where('id', 1).get()
      expect(results[0].name).toBe('RENAMED')
    })

    it('should run forceUpdate payloads through preparePersistencePayload overrides', async () => {
      const PreparedModel = class extends Model<TestRecord> {
        static table = 'tests' as any
        static getAdapter() { return adapter as ORMAdapter }
        static resolveTable() { return 'tests' }

        protected static override async preparePersistencePayload(data: PlainObject): Promise<PlainObject> {
          const payload = await super.preparePersistencePayload(data)
          if (typeof payload.name === 'string') {
            payload.name = payload.name.toUpperCase()
          }
          return payload
        }
      }

      await new QueryBuilder<TestRecord>(PreparedModel).where('id', 2).forceUpdate({ name: 'renamed' })
      const results = await qb().where('id', 2).get()
      expect(results[0].name).toBe('RENAMED')
    })

    it('should apply casts to bulk update payloads', async () => {
      const CastModel = class extends Model<TestRecord> {
        static table = 'tests' as any
        static override casts = { score: 'number' } as const
        static getAdapter() { return adapter as ORMAdapter }
        static resolveTable() { return 'tests' }
      }

      await new QueryBuilder<TestRecord>(CastModel).where('id', 3).update({ score: '42' })
      const results = await qb().where('id', 3).get()
      expect(results[0].score).toBe(42)
    })
  })

  describe('delete', () => {
    it('should delete matching records', async () => {
      await qb().where('name', 'Eve').delete()
      const count = await qb().count()
      expect(count).toBe(4)
    })
  })

  describe('thenable', () => {
    it('should be awaitable directly', async () => {
      const results = await qb().where('role', 'admin')
      expect(results).toHaveLength(2)
    })

    it('should support .then()', async () => {
      const count = await qb().where('role', 'user').then((r) => r.length)
      expect(count).toBe(3)
    })
  })

  describe('getConditions / getOptions', () => {
    it('should expose internal conditions', () => {
      const builder = qb().where('name', 'Alice').where('score', '>', 90)
      const conditions = builder.getConditions()
      expect(conditions).toHaveLength(2)
      expect(conditions[0]).toEqual({ type: 'simple', field: 'name', operator: '=', value: 'Alice' })
    })

    it('should expose internal options', () => {
      const builder = qb().orderBy('score', 'desc').limit(10).offset(5)
      const opts = builder.getOptions()
      expect(opts.orderBy).toEqual([{ column: 'score', direction: 'desc' }])
      expect(opts.limitValue).toBe(10)
      expect(opts.offsetValue).toBe(5)
    })
  })

  describe('scope', () => {
    it('should throw for unknown scope', () => {
      expect(() => qb().scope('nonexistent')).toThrow('unknown scope')
    })
  })

  describe('complex conditions', () => {
    it('should combine where and orWhere', async () => {
      // (role = admin) OR (score > 85)
      const results = await qb().where('role', 'admin').orWhere('score', '>', 85).get()
      // Alice (admin, 95), Diana (admin, 60), Eve (90)
      expect(results).toHaveLength(3)
    })

    it('should chain whereNull with where', async () => {
      const results = await qb().where('role', 'user').whereNull('email').get()
      expect(results).toHaveLength(2) // Charlie, Eve
    })

    it('should combine whereIn with other conditions', async () => {
      const results = await qb().whereIn('role', ['admin']).where('score', '>', 80).get()
      expect(results).toHaveLength(1) // Alice
    })
  })
})
