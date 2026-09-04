import type {
  Notifiable,
  NotificationMailMessage,
  SlackMessage,
} from './types'

/**
 * Base notification class. Subclasses declare their channels in `via()` and one
 * `to*()` method per channel; `static shouldQueue`/`queue`/`delay` control
 * queueing.
 */
export abstract class Notification {
  static shouldQueue: boolean = false

  static queue?: string

  /** Delay in milliseconds before sending. */
  static delay?: number

  readonly id: string

  readonly createdAt: Date

  constructor() {
    this.id = this.generateId()
    this.createdAt = new Date()
  }

  /** The notification's delivery channels. */
  abstract via(notifiable: Notifiable): string[]

  toMail?(notifiable: Notifiable): NotificationMailMessage

  toDatabase?(notifiable: Notifiable): Record<string, unknown>

  toSlack?(notifiable: Notifiable): SlackMessage

  /** Fallback representation for any channel with no dedicated method. */
  toArray?(notifiable: Notifiable): Record<string, unknown>

  /** Notification type; defaults to the class name. */
  get type(): string {
    return this.constructor.name
  }

  /** Override to skip delivery for a given notifiable. */
  shouldSend(_notifiable: Notifiable): boolean | Promise<boolean> {
    return true
  }

  protected generateId(): string {
    const timestamp = Date.now().toString(36)
    const random = Math.random().toString(36).substring(2, 10)
    return `notif_${timestamp}${random}`
  }

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
