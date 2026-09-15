import { eq, type SQL } from 'drizzle-orm'
import { bigint, boolean, integer, jsonb, numeric, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { defineModel } from '../src/Model'
import { SoftDeletes } from '../src/SoftDeletes'

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
function assertType<T extends true>(_value?: T): void {}

const ledger = pgTable('ledger', {
  id: serial('id').primaryKey(),
  amount: integer('amount').notNull(),
  tip: integer('tip'),
  price: numeric('price', { precision: 12, scale: 2 }).notNull(),
  units: bigint('units', { mode: 'bigint' }).notNull(),
  views: bigint('views', { mode: 'number' }).notNull(),
  placedAt: timestamp('placed_at', { withTimezone: true }).notNull(),
  paid: boolean('paid').notNull(),
  meta: jsonb('meta').$type<{ tags: string[] }>(),
  memo: text('memo'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
})

const accounts = pgTable('accounts', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
})

class Entry extends defineModel(ledger) {}
class TrashableEntry extends SoftDeletes(defineModel(ledger)) {}

const query = Entry.newQuery()

// A sum keeps the column's kind: numeric is a string, so no digit is lost.
assertType<Equals<Awaited<ReturnType<typeof query.sum<'amount'>>>, number>>()
assertType<Equals<Awaited<ReturnType<typeof query.sum<'tip'>>>, number>>()
assertType<Equals<Awaited<ReturnType<typeof query.sum<'price'>>>, string>>()
assertType<Equals<Awaited<ReturnType<typeof query.sum<'units'>>>, bigint>>()
assertType<Equals<Awaited<ReturnType<typeof query.sum<'views'>>>, number>>()

// An average is fractional: exact kinds come back as a decimal string, and none match is null.
assertType<Equals<Awaited<ReturnType<typeof query.avg<'amount'>>>, number | null>>()
assertType<Equals<Awaited<ReturnType<typeof query.avg<'price'>>>, string | null>>()
assertType<Equals<Awaited<ReturnType<typeof query.avg<'units'>>>, string | null>>()

// min/max decode as the column does, nullable column or not.
assertType<Equals<Awaited<ReturnType<typeof query.min<'placedAt'>>>, Date | null>>()
assertType<Equals<Awaited<ReturnType<typeof query.max<'deletedAt'>>>, Date | null>>()
assertType<Equals<Awaited<ReturnType<typeof query.max<'price'>>>, string | null>>()

assertType<Equals<Awaited<ReturnType<typeof query.exists>>, boolean>>()
assertType<Equals<ReturnType<typeof query.toSql>, SQL | undefined>>()

// @ts-expect-error a timestamp has no sum
void query.sum('placedAt')
// @ts-expect-error a boolean has no sum
void query.sum('paid')
// @ts-expect-error a json column has no average
void query.avg('meta')
// @ts-expect-error not a column of the model
void query.max('missing')

// withTrashed() hands back an untyped record: any name goes, and the kind is unknown.
const trashed = TrashableEntry.withTrashed()
assertType<Equals<Awaited<ReturnType<typeof trashed.sum<'amount'>>>, number | bigint | string>>()

// Without a query, the rows are the table's.
const plain = Entry.where('amount', '>', 1).toDrizzle().orderBy(ledger.id).limit(20)
assertType<Equals<Awaited<typeof plain>, Array<typeof ledger.$inferSelect>>>()
const narrowedRows = Entry.select('id', 'memo').toDrizzle()
assertType<Equals<Awaited<typeof narrowedRows>, Array<Pick<typeof ledger.$inferSelect, 'id' | 'memo'>>>>()
// @ts-expect-error joins need a query of the caller's own
void Entry.newQuery().toDrizzle().leftJoin

// Handed a query, it keeps that query's Drizzle type, selection and joins included.
declare const db: PostgresJsDatabase
const joined = Entry.newQuery()
  .toDrizzle(db.select({ id: ledger.id, account: accounts.name }).from(ledger).leftJoin(accounts, eq(ledger.amount, accounts.id)))
  .limit(20)
assertType<Equals<Awaited<typeof joined>, Array<{ id: number; account: string | null }>>>()
