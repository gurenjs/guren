import { Event } from '@guren/server'
import type { TaskRecord } from '../Models/Task.js'

/**
 * Event fired when a new task is created.
 */
export class TaskCreated extends Event {
  constructor(
    public readonly task: TaskRecord,
    public readonly userId: number
  ) {
    super()
  }
}
