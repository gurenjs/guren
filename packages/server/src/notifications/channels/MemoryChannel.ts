import type { NotificationChannel, Notifiable, SentNotification } from '../types'
import type { Notification } from '../Notification'

/**
 * Memory notification channel for testing.
 *
 * Stores all sent notifications in memory for assertions.
 *
 * @example
 * ```typescript
 * const memoryChannel = new MemoryChannel()
 * notifications.registerChannel('memory', memoryChannel)
 *
 * await notifications.send(user, new OrderShipped(order))
 *
 * memoryChannel.assertSentTo(user, 'OrderShipped')
 * memoryChannel.assertCount(1)
 * ```
 */
export class MemoryChannel implements NotificationChannel {
  readonly name = 'memory'

  /**
   * All sent notifications.
   */
  sent: SentNotification[] = []

  /**
   * Send (store) the notification.
   */
  async send(notifiable: Notifiable, notification: Notification): Promise<void> {
    this.sent.push({
      notifiable,
      notification,
      channels: notification.via(notifiable),
      timestamp: new Date(),
    })
  }

  /**
   * Assert that a notification was sent to a notifiable.
   */
  assertSentTo(notifiable: Notifiable, notificationType?: string): void {
    const found = this.sent.some((record) => {
      const matchesNotifiable = record.notifiable === notifiable
      const matchesType = notificationType
        ? record.notification.type === notificationType
        : true
      return matchesNotifiable && matchesType
    })

    if (!found) {
      const typeMsg = notificationType ? ` of type "${notificationType}"` : ''
      throw new Error(`Expected notification${typeMsg} to be sent to notifiable`)
    }
  }

  /**
   * Assert that a notification was not sent to a notifiable.
   */
  assertNotSentTo(notifiable: Notifiable, notificationType?: string): void {
    const found = this.sent.some((record) => {
      const matchesNotifiable = record.notifiable === notifiable
      const matchesType = notificationType
        ? record.notification.type === notificationType
        : true
      return matchesNotifiable && matchesType
    })

    if (found) {
      const typeMsg = notificationType ? ` of type "${notificationType}"` : ''
      throw new Error(
        `Expected notification${typeMsg} not to be sent to notifiable`
      )
    }
  }

  /**
   * Assert the total count of sent notifications.
   */
  assertCount(count: number): void {
    if (this.sent.length !== count) {
      throw new Error(
        `Expected ${count} notifications to be sent, but ${this.sent.length} were sent`
      )
    }
  }

  /**
   * Assert that a notification type was sent.
   */
  assertSent(notificationType: string): void {
    const found = this.sent.some(
      (record) => record.notification.type === notificationType
    )

    if (!found) {
      throw new Error(
        `Expected notification of type "${notificationType}" to be sent`
      )
    }
  }

  /**
   * Assert that a notification type was not sent.
   */
  assertNotSent(notificationType: string): void {
    const found = this.sent.some(
      (record) => record.notification.type === notificationType
    )

    if (found) {
      throw new Error(
        `Expected notification of type "${notificationType}" not to be sent`
      )
    }
  }

  /**
   * Assert that no notifications were sent.
   */
  assertNothingSent(): void {
    if (this.sent.length > 0) {
      throw new Error(
        `Expected no notifications to be sent, but ${this.sent.length} were sent`
      )
    }
  }

  /**
   * Get notifications sent to a specific notifiable.
   */
  getSentTo(notifiable: Notifiable): SentNotification[] {
    return this.sent.filter((record) => record.notifiable === notifiable)
  }

  /**
   * Get notifications of a specific type.
   */
  getSentOfType(notificationType: string): SentNotification[] {
    return this.sent.filter(
      (record) => record.notification.type === notificationType
    )
  }

  /**
   * Check if a notification was sent to a notifiable.
   */
  hasSentTo(notifiable: Notifiable, notificationType?: string): boolean {
    return this.sent.some((record) => {
      const matchesNotifiable = record.notifiable === notifiable
      const matchesType = notificationType
        ? record.notification.type === notificationType
        : true
      return matchesNotifiable && matchesType
    })
  }

  /**
   * Check if a notification type was sent.
   */
  hasSent(notificationType: string): boolean {
    return this.sent.some(
      (record) => record.notification.type === notificationType
    )
  }

  /**
   * Get the count of sent notifications.
   */
  count(): number {
    return this.sent.length
  }

  /**
   * Get the last sent notification.
   */
  last(): SentNotification | undefined {
    return this.sent[this.sent.length - 1]
  }

  /**
   * Get the first sent notification.
   */
  first(): SentNotification | undefined {
    return this.sent[0]
  }

  /**
   * Clear all sent notifications.
   */
  clear(): void {
    this.sent = []
  }
}
