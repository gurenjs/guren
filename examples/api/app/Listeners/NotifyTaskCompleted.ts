import { Listener } from '@guren/server'
import { TaskCompleted } from '../Events/TaskCompleted.js'

/**
 * Listener that sends notifications when a task is completed.
 * This listener is queued for background processing.
 */
export class NotifyTaskCompleted extends Listener<TaskCompleted> {
  static override event = TaskCompleted
  static override shouldQueue = true
  static override queue = 'notifications'
  static override priority = 0

  async handle(event: TaskCompleted): Promise<void> {
    // In a real app, this could send push notifications, emails, etc.
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
