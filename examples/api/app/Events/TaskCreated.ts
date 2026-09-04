import { Event } from '@guren/core'
import type { TaskRecord } from '../Models/Task.js'

export class TaskCreated extends Event {
  constructor(
    public readonly task: TaskRecord,
    public readonly userId: number
  ) {
    super()
  }
}
