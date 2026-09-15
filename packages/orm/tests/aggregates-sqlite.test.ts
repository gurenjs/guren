import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { and, eq, gt } from 'drizzle-orm'
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'
import { integer, numeric, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'
import { Model, defineModel } from '../src/Model'
import type { ORMAdapter, PlainObject } from '../src/Model'
import { SoftDeletes } from '../src/SoftDeletes'
import { useSqlite } from './sqlite-fixture'

// Against the real bun:sqlite driver: every aggregate and both Drizzle escapes
// carry the model's global scopes, SoftDeletes included, the way get() does.

const ordersTable = sqliteTable('orders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tenantId: integer('tenant_id').notNull(),
  amount: integer('amount').notNull(),
  price: numeric('price').notNull(),
  units: numeric('units', { mode: 'bigint' }).notNull(),
  weight: real('weight').notNull(),
  placedAt: integer('placed_at', { mode: 'timestamp' }).notNull(),
  note: text('note'),
  deletedAt: text('deleted_at'),
})

const tenantsTable = sqliteTable('tenants', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
})

const DDL = `
  CREATE TABLE tenants (id integer primary key, name text not null);
  CREATE TABLE orders (
    id integer primary key autoincrement, tenant_id integer not null, amount integer not null,
    price numeric not null, units numeric not null, weight real not null, placed_at integer not null, note text, deleted_at text
  );
  INSERT INTO tenants (id, name) VALUES (1, 'acme'), (2, 'globex');
  INSERT INTO orders (tenant_id, amount, price, units, weight, placed_at, note, deleted_at) VALUES
    (1, 10, '1.25', 3, 1e20, 1700000000, 'a', NULL),
    (1, 20, '2.50', 4, 1e20, 1700000100, 'b', NULL),
    (1, 400, '9.00', 5, 1e20, 1600000000, 'trashed', '2020-01-01'),
    (2, 1000, '100.00', 6, 1e20, 1800000000, 'other tenant', NULL);
`

describe('QueryBuilder aggregates and Drizzle escapes (bun:sqlite)', () => {
  const log: string[] = []
  useSqlite(DDL, { log })
  const sqliteDb = () => DrizzleAdapter.getDatabase() as unknown as SQLiteBunDatabase

  class Order extends defineModel(ordersTable) {}

  class TrashableOrder extends SoftDeletes(defineModel(ordersTable)) {}

  class TenantOrder extends SoftDeletes(defineModel(ordersTable)) {}
  TenantOrder.addGlobalScope('tenant', (q) => q.where('tenantId', 1))

  describe('sum / avg / min / max', () => {
    it('returns each column in its own kind', async () => {
      const query = Order.newQuery()

      expect(await query.sum('amount')).toBe(1430)
      expect(await query.sum('price')).toBe('112.75')
      expect(await query.sum('units')).toBe(18n)
      // A float total past 2^53 is not precision loss: only an integer column's is refused.
      expect(await query.sum('weight')).toBe(4e20)
      expect(await query.avg('amount')).toBe(357.5)
      expect(await query.min('amount')).toBe(10)
      expect(await query.max('placedAt')).toEqual(new Date(1800000000 * 1000))
    })

    it('applies the SoftDeletes scope, and withTrashed() lifts only that one', async () => {
      expect(await TrashableOrder.newQuery().sum('amount')).toBe(1030)
      expect(await TrashableOrder.newQuery().max('amount')).toBe(1000)
      expect(await TrashableOrder.withTrashed().sum('amount')).toBe(1430)

      expect(await TenantOrder.newQuery().sum('amount')).toBe(30)
      expect(await TenantOrder.withTrashed().sum('amount')).toBe(430)
      expect(log.at(-1)).toContain('"tenant_id" = ?')
    })

    it('keeps the scopes outside a top-level orWhere()', async () => {
      const total = await TenantOrder.where('amount', '>', 15).orWhere('amount', 1000).sum('amount')

      expect(total).toBe(20)
    })

    it('answers an empty match with the zero of the column kind, and null for the rest', async () => {
      const none = () => Order.where('amount', '>', 1_000_000)

      expect(await none().sum('amount')).toBe(0)
      expect(await none().sum('price')).toBe('0')
      expect(await none().sum('units')).toBe(0n)
      expect(await none().avg('amount')).toBeNull()
      expect(await none().min('placedAt')).toBeNull()
      expect(await none().max('amount')).toBeNull()
    })

    it('treats a filter whose every value was undefined as matching nothing, as first() does', async () => {
      const tenantId: number | undefined = undefined
      const lost = () => Order.where({ tenantId })

      expect(await lost().sum('amount')).toBe(0)
      expect(await lost().avg('amount')).toBeNull()
      expect(await lost().max('amount')).toBeNull()
      expect(await lost().exists()).toBe(false)
    })

    it('throws on an adapter without aggregateAdvanced rather than summing in memory', async () => {
      const basic: ORMAdapter = {
        async findMany<T extends PlainObject = PlainObject>() { return [] as T[] },
        async findUnique<T extends PlainObject = PlainObject>() { return null as T | null },
        async create<T extends PlainObject = PlainObject>() { return {} as T },
      }
      class Basic extends Model<PlainObject> {
        static override table = ordersTable
      }
      Basic.useAdapter(basic)

      await expect(Basic.newQuery().sum('amount')).rejects.toThrow('sum() needs an adapter that implements aggregateAdvanced')
    })
  })

  describe('exists', () => {
    it('reads one row under the scopes', async () => {
      expect(await TenantOrder.where('amount', 400).exists()).toBe(false)
      expect(await TenantOrder.withTrashed().where('amount', 400).exists()).toBe(true)
      expect(log.at(-1)).toContain('limit ?')
    })
  })

  describe('toSql', () => {
    it('hands a hand-built query the scopes as one fragment', async () => {
      const rows = await sqliteDb()
        .select({ note: ordersTable.note, tenant: tenantsTable.name })
        .from(ordersTable)
        .innerJoin(tenantsTable, eq(ordersTable.tenantId, tenantsTable.id))
        .where(and(TenantOrder.newQuery().toSql(), gt(ordersTable.amount, 5)))

      expect(rows).toEqual([{ note: 'a', tenant: 'acme' }, { note: 'b', tenant: 'acme' }])
    })

    it('is undefined for a model with no conditions', () => {
      expect(Order.newQuery().toSql()).toBeUndefined()
    })
  })

  describe('toDrizzle', () => {
    it('starts from the scoped select', async () => {
      const rows = await TenantOrder.newQuery().toDrizzle()

      expect(rows.map((row) => row.note)).toEqual(['a', 'b'])
    })

    it('ANDs a later where() with the scopes instead of replacing them', async () => {
      const viaSql = await TenantOrder.newQuery().toDrizzle().where(gt(ordersTable.amount, 15))
      const viaCallback = await TenantOrder.newQuery()
        .toDrizzle(sqliteDb().select().from(ordersTable))
        .where(() => gt(ordersTable.amount, 15))

      expect(viaSql.map((row) => row.note)).toEqual(['b'])
      expect(viaCallback.map((row) => row.note)).toEqual(['b'])
    })

    it('puts the caller conditions on a joined query and keeps a where() it already had', async () => {
      const joined = await TenantOrder.where('amount', '<', 15)
        .toDrizzle(sqliteDb().select().from(ordersTable).innerJoin(tenantsTable, eq(ordersTable.tenantId, tenantsTable.id)))
      const prefiltered = await TenantOrder.newQuery()
        .toDrizzle(sqliteDb().select().from(ordersTable).$dynamic().where(eq(ordersTable.note, 'b')))

      expect(joined.map((row) => row.tenants.name)).toEqual(['acme'])
      expect(prefiltered.map((row) => row.amount)).toEqual([20])
    })

    it('carries orderBy, limit and offset, and select() on the no-argument form', async () => {
      const paged = await TenantOrder.newQuery().orderBy('amount', 'desc').limit(1).offset(1).toDrizzle()
      const narrowed = await Order.select('note').where('amount', 10).toDrizzle()
      const onQuery = await TenantOrder.newQuery().orderBy('amount', 'desc').toDrizzle(sqliteDb().select().from(ordersTable))

      expect(paged.map((row) => row.note)).toEqual(['a'])
      expect(narrowed).toEqual([{ note: 'a' }])
      expect(onQuery.map((row) => row.amount)).toEqual([20, 10])
    })
  })

  describe('Model.query()', () => {
    let warn: ReturnType<typeof spyOn>

    beforeEach(() => {
      warn = spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      warn.mockRestore()
    })

    it('still reads past the scopes, and warns once per model', async () => {
      class Legacy extends SoftDeletes(defineModel(ordersTable)) {}

      const rows = await Legacy.query()
      await Legacy.query()

      expect(rows).toHaveLength(4)
      const calls = warn.mock.calls.filter(([message]: unknown[]) => String(message).includes('Legacy.query()'))
      expect(calls).toHaveLength(1)
      expect(String(calls[0][0])).toContain('[guren] Deprecation (model-query-raw)')
    })
  })
})
