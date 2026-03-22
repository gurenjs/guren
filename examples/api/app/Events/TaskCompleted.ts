import { Event } from '@guren/core'
import type { TaskRecord } from '../Models/Task.js'

/**
 * Event fired when a task is marked as completed.
 */
export class TaskCompleted extends Event {
  constructor(
    public readonly task: TaskRecord,
    public readonly userId: number
  ) {
    super()
  }
}
