import { drizzle } from 'drizzle-orm/postgres-js'
import { pgTable, serial, text } from 'drizzle-orm/pg-core'
import { Model } from '../src/Model'

const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
})

export type UserRecord = typeof users.$inferSelect

class User extends Model<UserRecord> {
  static override table = users
  static override readonly recordType = {} as UserRecord
}

const schema = { users }
type Schema = typeof schema

declare const db: ReturnType<typeof drizzle<typeof schema>>

// Should accept a Drizzle database without type errors.
User.query(db).execute()

// Type assertions with a typed builder: Model.query(db) should preserve the builder's result shape.
type FakeSelect = { from(table: typeof users): { execute: () => Promise<UserRecord[]> } }
type FakeDb = { select: () => FakeSelect }

declare const fakeDb: FakeDb

const fakeQuery = User.query(fakeDb)
type FakeRow = Awaited<ReturnType<typeof fakeQuery.execute>>[number]
const _fakeRowIsUser: UserRecord = {} as FakeRow
const _userIsFakeRow: FakeRow = {} as UserRecord
