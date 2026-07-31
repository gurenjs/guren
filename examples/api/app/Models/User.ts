import { AuthenticatableModel, defineModel, type HasManyRecord } from '@guren/core'
import { users } from '../../db/schema.js'
import type { TaskRecord } from './Task.js'

export type UserRecord = typeof users.$inferSelect
export type NewUserRecord = typeof users.$inferInsert

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
}) {
  static fillable = ['name', 'email', 'password']
  static override hidden = ['passwordHash']
  static override relationTypes: { tasks: HasManyRecord<TaskRecord> } = {
    tasks: [],
  }
}

if (typeof User.hasMany === 'function') {
  User.hasMany('tasks', (() => import('./Task.js').then((module) => module.Task)) as any, 'userId', 'id')
}
