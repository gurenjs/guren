import { AuthenticatableModel, type HasManyRecord } from '@guren/core'
import { users } from '../../db/schema.js'
import type { TaskRecord } from './Task.js'

export type UserRecord = typeof users.$inferSelect
export type NewUserRecord = typeof users.$inferInsert

export class User extends AuthenticatableModel<UserRecord> {
  static override table = users
  static override readonly recordType = {} as UserRecord
  static override relationTypes: { tasks: HasManyRecord<TaskRecord> } = {
    tasks: [],
  }
}
