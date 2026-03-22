import { Listener, type BroadcastManager, type NotificationManager, type Notifiable, type StorageManager } from '@guren/core'
import { TaskCompleted } from '../Events/TaskCompleted.js'
import { TaskCompletedNotification } from '../Notifications/TaskCompletedNotification.js'

/**
 * Listener that sends notifications when a task is completed.
 * This listener is queued for background processing.
 */
export class NotifyTaskCompleted extends Listener<TaskCompleted> {
  static override event = TaskCompleted
  static override shouldQueue = true
  static override queue = 'notifications'
  static override priority = 0

  constructor(
    private readonly notifications: NotificationManager,
    private readonly broadcast: BroadcastManager,
    private readonly storage: StorageManager,
  ) {
    super()
  }

  async handle(event: TaskCompleted): Promise<void> {
    const payload = {
      taskId: event.task.id,
      title: event.task.title,
      userId: event.userId,
    }

    const recipient: Notifiable = {
      notifications: [],
      routeNotificationFor(): string | null {
        return null
      },
    }

    await this.storage.disk('public').put(`notifications/tasks/${event.task.id}.json`, JSON.stringify(payload))
    await this.notifications.sendNow(recipient, new TaskCompletedNotification(event.task))
    await this.broadcast.broadcast('tasks', 'task.completed', payload)
    await this.broadcast.broadcast(`users.${event.userId}.tasks`, 'task.completed', payload)

    console.log(
      `[Notification] Task "${event.task.title}" completed by user ${event.userId}`
    )
  }

  override shouldHandle(event: TaskCompleted): boolean {
    // Only notify if the task was marked as completed
    return event.task.completed === true
  }

  async failed(event: TaskCompleted, error: Error): Promise<void> {
    console.error(
      `[Notification] Failed to send notification for task "${event.task.title}":`,
      error.message
    )
  }
}
