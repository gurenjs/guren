import { describe, expect, test } from 'bun:test'
import type { SQL } from 'drizzle-orm'
import { MySqlDialect, bigint as mysqlBigint, decimal, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core'
import { PgDialect, bigint as pgBigint, boolean, customType, integer, jsonb, numeric, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { integer as sqliteInteger, sqliteTable } from 'drizzle-orm/sqlite-core'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'
import type { DrizzleDatabase } from '../src/adapters/drizzle-types'
import type { IncrementValue } from '../src/increment-amount'

const pgInteger = customType<{ data: number }>({ dataType: () => 'integer' })

const ledger = pgTable('ledger', {
  views: integer('views').notNull(),
  ratio: real('ratio').notNull(),
  price: numeric('price', { precision: 12, scale: 2 }).notNull(),
  priceNumber: numeric('price_number', { mode: 'number' }).notNull(),
  units: pgBigint('units', { mode: 'bigint' }).notNull(),
  unitsText: pgBigint('units_text', { mode: 'string' }).notNull(),
  custom: pgInteger('custom').notNull(),
  title: text('title').notNull(),
  token: uuid('token').notNull(),
  paid: boolean('paid').notNull(),
  placedAt: timestamp('placed_at').notNull(),
  placedOn: timestamp('placed_on', { mode: 'string' }).notNull(),
  meta: jsonb('meta'),
})

const stock = mysqlTable('stock', {
  count: int('count', { unsigned: true }).notNull(),
  total: mysqlBigint('total', { mode: 'bigint', unsigned: true }).notNull(),
  totalText: mysqlBigint('total_text', { mode: 'string', unsigned: true }).notNull(),
  price: decimal('price', { precision: 12, scale: 2, unsigned: true }).notNull(),
  name: varchar('name', { length: 32 }).notNull(),
})

const events = sqliteTable('events', {
  hits: sqliteInteger('hits').notNull(),
  seenAt: sqliteInteger('seen_at', { mode: 'timestamp' }).notNull(),
})

/** A database that records what `set()` was handed and answers RETURNING with `rows` rows. */
function recordingDatabase(rows = 2): { sets: Array<Record<string, SQL>> } {
  const sets: Array<Record<string, SQL>> = []
  const db = {
    select: () => ({ from: () => ({}) }),
    insert: () => ({ values: () => ({}) }),
    update: () => ({
      set(data: Record<string, SQL>) {
        sets.push(data)
        const query = { where: () => query, returning: async () => Array.from({ length: rows }, () => ({})) }
        return query
      },
    }),
  }
  DrizzleAdapter.configure(db as unknown as DrizzleDatabase)
  return { sets }
}

async function increment(table: unknown, field: string, amount: IncrementValue): Promise<number | undefined> {
  return DrizzleAdapter.incrementAdvanced?.(table, [], field, amount)
}

describe('DrizzleAdapter.incrementAdvanced', () => {
  // A bound amount reaches each driver in its own encoding: D1 takes no bigint,
  // and MySQL reads a bound string as a double.
  test('should inline the amount as a literal, with nothing left to bind', async () => {
    const { sets } = recordingDatabase()
    const pg = new PgDialect()
    const mysql = new MySqlDialect()

    await increment(ledger, 'views', 2)
    await increment(ledger, 'units', -9007199254740993n)
    await increment(ledger, 'price', '10.50')
    await increment(ledger, 'priceNumber', 1e21)
    await increment(stock, 'price', '-0.01')

    expect(sets.slice(0, 4).map((data) => pg.sqlToQuery(Object.values(data)[0]!))).toEqual([
      { sql: '"ledger"."views" + 2', params: [] },
      { sql: '"ledger"."units" + -9007199254740993', params: [] },
      { sql: '"ledger"."price" + 10.50', params: [] },
      { sql: '"ledger"."price_number" + 1e+21', params: [] },
    ])
    expect(mysql.sqlToQuery(sets[4]!.price!)).toEqual({ sql: '`stock`.`price` + -0.01', params: [] })
  })

  test('should count the rows RETURNING hands back', async () => {
    recordingDatabase(3)

    expect(await increment(ledger, 'views', 1)).toBe(3)
  })

  test('should take every column kind that holds a number', async () => {
    const { sets } = recordingDatabase()
    const numeric: Array<[unknown, string]> = [
      [ledger, 'views'], [ledger, 'ratio'], [ledger, 'price'], [ledger, 'priceNumber'], [ledger, 'units'], [ledger, 'unitsText'],
      // Its `dataType` is `custom`: the adapter cannot tell, so the database judges.
      [ledger, 'custom'],
      [stock, 'count'], [stock, 'total'], [stock, 'totalText'], [stock, 'price'],
      [events, 'hits'],
    ]

    for (const [table, field] of numeric) await increment(table, field, 1)

    expect(sets.map((data) => Object.keys(data)[0])).toEqual(numeric.map(([, field]) => field))
  })

  // SQLite stores `'one' + 1` as `1` without an error.
  test('should refuse a column that holds no number, before any write', async () => {
    const { sets } = recordingDatabase()
    const others: Array<[unknown, string]> = [
      [ledger, 'title'], [ledger, 'token'], [ledger, 'paid'], [ledger, 'placedAt'], [ledger, 'placedOn'], [ledger, 'meta'],
      [stock, 'name'], [events, 'seenAt'],
    ]

    for (const [table, field] of others) {
      await expect(increment(table, field, 1)).rejects.toThrow(`cannot add to "${field}"`)
    }
    expect(sets).toEqual([])
  })

  test('should refuse a fraction on an integer column, signed, unsigned or held as a string', async () => {
    const { sets } = recordingDatabase()

    for (const [table, field] of [[ledger, 'views'], [ledger, 'units'], [ledger, 'unitsText'], [stock, 'count'], [stock, 'total'], [events, 'hits']] as const) {
      await expect(increment(table, field, 1.5)).rejects.toThrow('an integer column')
    }
    await expect(increment(ledger, 'unitsText', '1.5')).rejects.toThrow('an integer column')
    expect(sets).toEqual([])
  })

  test('should refuse a string that is not a decimal literal where it would be inlined', async () => {
    const { sets } = recordingDatabase()

    for (const amount of ['1; DROP TABLE ledger', '1e3', '', '1 --']) {
      await expect(increment(ledger, 'price', amount)).rejects.toThrow('not a numeric literal')
    }
    await expect(increment(ledger, 'priceNumber', Number.NaN)).rejects.toThrow('not a numeric literal')
    expect(sets).toEqual([])
  })
})
