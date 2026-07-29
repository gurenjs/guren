import type {
  NotificationChannel,
  Notifiable,
  DatabaseNotification,
  DatabaseChannelOptions,
} from '../types'
import type { Notification } from '../Notification'
import { resolveNotifiableType } from '../notifiable-type'

/**
 * Database notification channel.
 *
 * Stores notifications in the database for in-app notifications.
 *
 * @example
 * ```typescript
 * const dbChannel = new DatabaseChannel({
 *   store: async (notifiable, notification) => {
 *     await db.insert(notifications).values(notification)
 *   },
 * })
 * notifications.registerChannel('database', dbChannel)
 *
 * // In notification class:
 * toDatabase(notifiable: Notifiable): Record<string, unknown> {
 *   return {
 *     orderId: this.order.id,
 *     message: 'Your order has shipped',
 *   }
 * }
 * ```
 */
export class DatabaseChannel implements NotificationChannel {
  readonly name = 'database'
  protected stored: DatabaseNotification[] = []

  constructor(private options: DatabaseChannelOptions = {}) {}

  /**
   * Send the notification to the database.
   */
  async send(notifiable: Notifiable, notification: Notification): Promise<void> {
    // Get database data from notification
    const data = notification.toDatabase?.(notifiable)
    if (!data) {
      return
    }

    // Create notification record
    const record: DatabaseNotification = {
      id: notification.id,
      type: notification.type,
      notifiableId: this.getNotifiableId(notifiable),
      notifiableType: this.getNotifiableType(notifiable),
      data,
      readAt: null,
      createdAt: notification.createdAt,
    }

    // Store using custom handler or in-memory
    if (this.options.store) {
      await this.options.store(notifiable, record)
    } else {
      // Default: store in-memory (also add to notifiable if supported)
      this.stored.push(record)
      if (notifiable.notifications) {
        notifiable.notifications.push(record)
      }
    }
  }

  /**
   * Get the notifiable ID.
   */
  protected getNotifiableId(notifiable: Notifiable): string | number {
    // Try common ID properties
    const withId = notifiable as { id?: string | number }
    if (withId.id !== undefined) {
      return withId.id
    }

    // Fallback to string representation
    return String(notifiable)
  }

  /**
   * Get the notifiable type.
   */
  protected getNotifiableType(notifiable: Notifiable): string {
    return resolveNotifiableType(notifiable)
  }

  /**
   * Get all stored notifications (for testing).
   */
  getStored(): DatabaseNotification[] {
    return [...this.stored]
  }

  /**
   * Get stored notifications for a notifiable.
   */
  getStoredFor(notifiable: Notifiable): DatabaseNotification[] {
    const id = this.getNotifiableId(notifiable)
    const type = this.getNotifiableType(notifiable)
    return this.stored.filter(
      (n) => n.notifiableId === id && n.notifiableType === type
    )
  }

  /**
   * Clear stored notifications (for testing).
   */
  clear(): void {
    this.stored = []
  }
}
