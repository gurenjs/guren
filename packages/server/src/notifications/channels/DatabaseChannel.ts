import type {
  NotificationChannel,
  Notifiable,
  DatabaseNotification,
  DatabaseChannelOptions,
} from '../types'
import type { Notification } from '../Notification'
import { resolveNotifiableType } from '../notifiable-type'

/** Database notification channel, for in-app notifications. */
export class DatabaseChannel implements NotificationChannel {
  readonly name = 'database'
  protected stored: DatabaseNotification[] = []

  constructor(private options: DatabaseChannelOptions = {}) {}

  async send(notifiable: Notifiable, notification: Notification): Promise<void> {
    const data = notification.toDatabase?.(notifiable)
    if (!data) {
      return
    }

    const record: DatabaseNotification = {
      id: notification.id,
      type: notification.type,
      notifiableId: this.getNotifiableId(notifiable),
      notifiableType: this.getNotifiableType(notifiable),
      data,
      readAt: null,
      createdAt: notification.createdAt,
    }

    if (this.options.store) {
      await this.options.store(notifiable, record)
    } else {
      this.stored.push(record)
      if (notifiable.notifications) {
        notifiable.notifications.push(record)
      }
    }
  }

  protected getNotifiableId(notifiable: Notifiable): string | number {
    const withId = notifiable as { id?: string | number }
    if (withId.id !== undefined) {
      return withId.id
    }

    return String(notifiable)
  }

  protected getNotifiableType(notifiable: Notifiable): string {
    return resolveNotifiableType(notifiable)
  }

  getStored(): DatabaseNotification[] {
    return [...this.stored]
  }

  getStoredFor(notifiable: Notifiable): DatabaseNotification[] {
    const id = this.getNotifiableId(notifiable)
    const type = this.getNotifiableType(notifiable)
    return this.stored.filter(
      (n) => n.notifiableId === id && n.notifiableType === type
    )
  }

  clear(): void {
    this.stored = []
  }
}
