import { Model, type BelongsToRecord } from '@guren/orm'
import { tasks } from '../../db/schema.js'
import type { UserRecord } from './User.js'

export type TaskRecord = typeof tasks.$inferSelect
export type NewTaskRecord = typeof tasks.$inferInsert
export type TaskOwnerSummary = Pick<UserRecord, 'id' | 'name'>

export class Task extends Model<TaskRecord> {
  static override table = tasks
  static override readonly recordType = {} as TaskRecord
  static override relationTypes: { owner: BelongsToRecord<TaskOwnerSummary> } = {
    owner: null,
  }
}
