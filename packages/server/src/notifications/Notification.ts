import type {
  Notifiable,
  NotificationMailMessage,
  SlackMessage,
} from './types'

/**
 * Base notification class.
 *
 * @example
 * ```typescript
 * class OrderShipped extends Notification {
 *   static shouldQueue = true
 *   static queue = 'notifications'
 *
 *   constructor(private order: Order) {
 *     super()
 *   }
 *
 *   via(notifiable: Notifiable): string[] {
 *     return ['mail', 'database']
 *   }
 *
 *   toMail(notifiable: Notifiable): NotificationMailMessage {
 *     return {
 *       subject: `Order #${this.order.id} shipped`,
 *       html: '<p>Your order is on its way!</p>',
 *     }
 *   }
 *
 *   toDatabase(notifiable: Notifiable): Record<string, unknown> {
 *     return {
 *       orderId: this.order.id,
 *       message: 'Your order has shipped',
 *     }
 *   }
 * }
 * ```
 */
export abstract class Notification {
  /**
   * Whether this notification should be queued.
   */
  static shouldQueue: boolean = false

  /**
   * The queue name for this notification.
   */
  static queue?: string

  /**
   * Delay in milliseconds before sending.
   */
  static delay?: number

  /**
   * Unique notification ID.
   */
  readonly id: string

  /**
   * When the notification was created.
   */
  readonly createdAt: Date

  constructor() {
    this.id = this.generateId()
    this.createdAt = new Date()
  }

  /**
   * Get the notification's delivery channels.
   */
  abstract via(notifiable: Notifiable): string[]

  /**
   * Get the mail representation of the notification.
   */
  toMail?(notifiable: Notifiable): NotificationMailMessage

  /**
   * Get the database representation of the notification.
   */
  toDatabase?(notifiable: Notifiable): Record<string, unknown>

  /**
   * Get the Slack representation of the notification.
   */
  toSlack?(notifiable: Notifiable): SlackMessage

  /**
   * Get the array representation of the notification.
   * Used as a fallback for any channel.
   */
  toArray?(notifiable: Notifiable): Record<string, unknown>

  /**
   * Get the notification type (default: class name).
   */
  get type(): string {
    return this.constructor.name
  }

  /**
   * Check if the notification should be sent to the given notifiable.
   * Override to add custom logic.
   */
  shouldSend(_notifiable: Notifiable): boolean | Promise<boolean> {
    return true
  }

  /**
   * Generate a unique notification ID.
   */
  protected generateId(): string {
    const timestamp = Date.now().toString(36)
    const random = Math.random().toString(36).substring(2, 10)
    return `notif_${timestamp}${random}`
  }

  /**
   * Get static queue configuration.
   */
  static getQueueConfig(): {
    shouldQueue: boolean
    queue?: string
    delay?: number
  } {
    return {
      shouldQueue: this.shouldQueue,
      queue: this.queue,
      delay: this.delay,
    }
  }
}
