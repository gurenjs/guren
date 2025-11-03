import { Model, type HasManyRecord } from '@guren/core'
import { users } from '../../db/schema.js'
import type { PostRecord } from './Post.js'

export type UserRecord = typeof users.$inferSelect
export type NewUserRecord = typeof users.$inferInsert

export class User extends Model<UserRecord> {
  static override table = users
  static override readonly recordType = {} as UserRecord
  static override relationTypes: { posts: HasManyRecord<PostRecord> } = {
    posts: [],
  }
}
