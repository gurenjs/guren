import { AuthenticatableModel, type HasManyRecord } from '@guren/core'
import { users } from '../../db/schema.js'
import type { TaskRecord } from './Task.js'

export type UserRecord = typeof users.$inferSelect
export type NewUserRecord = typeof users.$inferInsert

export class User extends AuthenticatableModel<UserRecord> {
  static override table = users
  static fillable = ['name', 'email', 'password']
  static guarded = ['id', 'passwordHash', 'createdAt', 'updatedAt']
  static override readonly recordType = {} as UserRecord
  static override readonly createType = {} as Omit<NewUserRecord, 'passwordHash'> & {
    password: string
  }
  static override relationTypes: { tasks: HasManyRecord<TaskRecord> } = {
    tasks: [],
  }
}

if (typeof User.hasMany === 'function') {
  User.hasMany('tasks', (() => import('./Task.js').then((module) => module.Task)) as any, 'userId', 'id')
}
