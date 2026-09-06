import { defineModel, type BelongsToRecord } from '@guren/orm'
import { tasks } from '../../db/schema.js'
import type { UserRecord } from './User.js'

export type TaskRecord = typeof tasks.$inferSelect
export type NewTaskRecord = typeof tasks.$inferInsert
export type TaskOwnerSummary = Pick<UserRecord, 'id' | 'name'>

export class Task extends defineModel(tasks, {
  fillable: ['title', 'description', 'completed', 'userId'],
}) {
  static override relationTypes: { owner: BelongsToRecord<TaskOwnerSummary> } = {
    owner: null,
  }
}

if (typeof Task.belongsTo === 'function') {
  Task.belongsTo('owner', (() => import('./User.js').then((module) => module.User)) as any, 'userId', 'id')
}
