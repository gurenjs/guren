import { Model } from '@guren/core'
import { users } from '../../db/schema.js'

export type UserRecord = typeof users.$inferSelect
export type NewUserRecord = typeof users.$inferInsert

export class User extends Model<UserRecord> {
  static override table = users
  static override readonly recordType = {} as UserRecord
}
