import type { NotificationChannel, Notifiable, SentNotification } from '../types'
import type { Notification } from '../Notification'

/**
 * Memory notification channel for testing: stores every sent notification in
 * memory for assertions.
 */
export class MemoryChannel implements NotificationChannel {
  readonly name = 'memory'

  sent: SentNotification[] = []

  async send(notifiable: Notifiable, notification: Notification): Promise<void> {
    this.sent.push({
      notifiable,
      notification,
      channels: notification.via(notifiable),
      timestamp: new Date(),
    })
  }

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

  assertCount(count: number): void {
    if (this.sent.length !== count) {
      throw new Error(
        `Expected ${count} notifications to be sent, but ${this.sent.length} were sent`
      )
    }
  }

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

  assertNothingSent(): void {
    if (this.sent.length > 0) {
      throw new Error(
        `Expected no notifications to be sent, but ${this.sent.length} were sent`
      )
    }
  }

  getSentTo(notifiable: Notifiable): SentNotification[] {
    return this.sent.filter((record) => record.notifiable === notifiable)
  }

  getSentOfType(notificationType: string): SentNotification[] {
    return this.sent.filter(
      (record) => record.notification.type === notificationType
    )
  }

  hasSentTo(notifiable: Notifiable, notificationType?: string): boolean {
    return this.sent.some((record) => {
      const matchesNotifiable = record.notifiable === notifiable
      const matchesType = notificationType
        ? record.notification.type === notificationType
        : true
      return matchesNotifiable && matchesType
    })
  }

  hasSent(notificationType: string): boolean {
    return this.sent.some(
      (record) => record.notification.type === notificationType
    )
  }

  count(): number {
    return this.sent.length
  }

  last(): SentNotification | undefined {
    return this.sent[this.sent.length - 1]
  }

  first(): SentNotification | undefined {
    return this.sent[0]
  }

  clear(): void {
    this.sent = []
  }
}
