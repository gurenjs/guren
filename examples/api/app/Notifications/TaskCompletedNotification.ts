import { Notification, type Notifiable } from '@guren/core'
import type { TaskRecord } from '../Models/Task.js'

export class TaskCompletedNotification extends Notification {
  constructor(private readonly task: TaskRecord) {
    super()
  }

  via(_notifiable: Notifiable): string[] {
    return ['database']
  }

  toDatabase(): Record<string, unknown> {
    return {
      taskId: this.task.id,
      title: this.task.title,
      completed: this.task.completed,
    }
  }
}
