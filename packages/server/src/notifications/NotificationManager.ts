import type {
  Notifiable,
  NotificationChannel,
  NotificationChannelFactory,
  NotificationManagerOptions,
  NotificationClass,
} from './types'
import type { Notification } from './Notification'
import { Job, registerJob, getQueueDriver } from '../queue'
import { resolveNotifiableType } from './notifiable-type'

/**
 * Notification manager for sending notifications through multiple channels.
 *
 * @example
 * ```typescript
 * const notifications = new NotificationManager()
 *
 * notifications
 *   .registerChannel('mail', new MailChannel(mailManager))
 *   .registerChannel('database', new DatabaseChannel())
 *   .registerChannel('slack', new SlackChannel(webhookUrl))
 *
 * // Send notification
 * await notifications.send(user, new OrderShipped(order))
 *
 * // Send to multiple users
 * await notifications.sendToMany(admins, new NewUserRegistered(user))
 * ```
 */
export class NotificationManager {
  protected channels: Map<string, NotificationChannel> = new Map()
  protected channelFactories: Map<string, NotificationChannelFactory> =
    new Map()
  protected resolvedChannels: Map<string, NotificationChannel> = new Map()

  constructor(options: NotificationManagerOptions = {}) {
    // Register provided channels
    if (options.channels) {
      for (const [name, channel] of Object.entries(options.channels)) {
        this.registerChannel(name, channel)
      }
    }

    // Register provided factories
    if (options.channelFactories) {
      for (const [name, factory] of Object.entries(options.channelFactories)) {
        this.registerChannelFactory(name, factory)
      }
    }
  }

  /**
   * Register a notification channel.
   */
  registerChannel(name: string, channel: NotificationChannel): this {
    this.channels.set(name, channel)
    return this
  }

  /**
   * Register a notification channel factory.
   */
  registerChannelFactory(
    name: string,
    factory: NotificationChannelFactory
  ): this {
    this.channelFactories.set(name, factory)
    return this
  }

  /**
   * Get a notification channel by name.
   */
  channel(name: string): NotificationChannel {
    // Check resolved cache
    const resolved = this.resolvedChannels.get(name)
    if (resolved) {
      return resolved
    }

    // Check direct channels
    const channel = this.channels.get(name)
    if (channel) {
      return channel
    }

    // Try to create from factory
    const factory = this.channelFactories.get(name)
    if (factory) {
      const created = factory({})
      this.resolvedChannels.set(name, created)
      return created
    }

    throw new Error(`Notification channel "${name}" not found`)
  }

  /**
   * Check if a channel is registered.
   */
  hasChannel(name: string): boolean {
    return (
      this.channels.has(name) ||
      this.channelFactories.has(name) ||
      this.resolvedChannels.has(name)
    )
  }

  /**
   * Get all registered channel names.
   */
  getChannelNames(): string[] {
    const names = new Set([
      ...this.channels.keys(),
      ...this.channelFactories.keys(),
      ...this.resolvedChannels.keys(),
    ])
    return Array.from(names)
  }

  /**
   * Send a notification to a notifiable entity.
   * Respects queue configuration on the notification class.
   */
  async send(notifiable: Notifiable, notification: Notification): Promise<void> {
    const NotificationClass = notification.constructor as NotificationClass
    const queueConfig = NotificationClass.getQueueConfig?.() ?? {
      shouldQueue: false,
    }

    if (queueConfig.shouldQueue) {
      await this.queue(notifiable, notification, queueConfig)
    } else {
      await this.sendNow(notifiable, notification)
    }
  }

  /**
   * Send a notification immediately (bypasses queue).
   */
  async sendNow(
    notifiable: Notifiable,
    notification: Notification
  ): Promise<void> {
    // Check if notification should be sent
    const shouldSend = await notification.shouldSend(notifiable)
    if (!shouldSend) {
      return
    }

    // Get channels to send through
    const viaChannels = notification.via(notifiable)

    // Send through each channel
    await Promise.all(
      viaChannels.map(async (channelName) => {
        try {
          const channel = this.channel(channelName)
          await channel.send(notifiable, notification)
        } catch (error) {
          // Log error but don't fail other channels
          console.error(
            `Failed to send notification via ${channelName}:`,
            error
          )
          throw error
        }
      })
    )
  }

  /**
   * Queue a notification for later delivery.
   */
  protected async queue(
    notifiable: Notifiable,
    notification: Notification,
    queueConfig: { queue?: string; delay?: number }
  ): Promise<void> {
    // Create and register the job
    const job = this.createNotificationJob()
    registerJob(job)

    const payload: SendNotificationPayload = {
      notifiableData: this.serializeNotifiable(notifiable),
      notificationData: this.serializeNotification(notification),
      notificationType: notification.type,
    }

    // Dispatch to queue
    if (queueConfig.delay) {
      await job.dispatchAfter(queueConfig.delay, payload, {
        queue: queueConfig.queue,
      })
    } else {
      await job.dispatch(payload, { queue: queueConfig.queue })
    }
  }

  /**
   * Send notification to multiple notifiables.
   */
  async sendToMany(
    notifiables: Notifiable[],
    notification: Notification
  ): Promise<void> {
    await Promise.all(
      notifiables.map((notifiable) => this.send(notifiable, notification))
    )
  }

  /**
   * Send notification immediately to multiple notifiables.
   */
  async sendNowToMany(
    notifiables: Notifiable[],
    notification: Notification
  ): Promise<void> {
    await Promise.all(
      notifiables.map((notifiable) => this.sendNow(notifiable, notification))
    )
  }

  /**
   * Serialize notifiable for queue storage.
   */
  protected serializeNotifiable(notifiable: Notifiable): SerializedNotifiable {
    // Basic serialization - can be overridden for custom behavior
    return {
      type: resolveNotifiableType(notifiable),
      data: { ...notifiable } as Record<string, unknown>,
    }
  }

  /**
   * Serialize notification for queue storage.
   */
  protected serializeNotification(
    notification: Notification
  ): SerializedNotification {
    return {
      type: notification.type,
      id: notification.id,
      data: { ...notification } as Record<string, unknown>,
    }
  }

  /**
   * Create the notification job class.
   */
  protected createNotificationJob(): typeof SendNotificationJob {
    // Bind manager reference for job handler
    const manager = this

    class BoundSendNotificationJob extends SendNotificationJob {
      // Declared, not inherited: this subclass is a binding proxy for the same
      // job, so it deliberately keeps the parent's wire name.
      static jobName = SendNotificationJob.jobName
      static notificationManager = manager
    }

    return BoundSendNotificationJob
  }
}

/**
 * Payload for queued notifications.
 */
interface SendNotificationPayload {
  notifiableData: SerializedNotifiable
  notificationData: SerializedNotification
  notificationType: string
}

interface SerializedNotifiable {
  type: string
  data: Record<string, unknown>
}

interface SerializedNotification {
  type: string
  id: string
  data: Record<string, unknown>
}

/**
 * Job for sending queued notifications.
 */
class SendNotificationJob extends Job<SendNotificationPayload> {
  static jobName = 'SendNotificationJob'
  static queue = 'notifications'
  static maxAttempts = 3

  // Will be set by NotificationManager
  static notificationManager: NotificationManager | null = null

  async handle(payload: SendNotificationPayload): Promise<void> {
    const manager = (this.constructor as typeof SendNotificationJob).notificationManager
    if (!manager) {
      throw new Error('NotificationManager not set on SendNotificationJob')
    }

    // Reconstruct notifiable (basic)
    const notifiable: Notifiable = {
      ...payload.notifiableData.data,
      notifiableType: payload.notifiableData.type,
      routeNotificationFor(channel: string): string | null {
        const key = `${channel}Route` as keyof typeof payload.notifiableData.data
        const value = payload.notifiableData.data[key]
        if (typeof value === 'string') return value

        // Fallback to common fields
        if (channel === 'mail') {
          const email = payload.notifiableData.data['email']
          return typeof email === 'string' ? email : null
        }
        return null
      },
    }

    // Reconstruct notification (basic)
    const notification = {
      ...payload.notificationData.data,
      id: payload.notificationData.id,
      type: payload.notificationType,
      via: () => {
        const viaChannels = (payload.notificationData.data as { _viaChannels?: string[] })._viaChannels
        return viaChannels ?? []
      },
      shouldSend: () => true,
      toMail: (payload.notificationData.data as { toMail?: unknown }).toMail,
      toDatabase: (payload.notificationData.data as { toDatabase?: unknown }).toDatabase,
      toSlack: (payload.notificationData.data as { toSlack?: unknown }).toSlack,
    } as unknown as import('./Notification').Notification

    await manager.sendNow(notifiable, notification)
  }
}

// Global instance management
let globalNotificationManager: NotificationManager | null = null

/**
 * Set the global notification manager.
 */
export function setNotificationManager(manager: NotificationManager): void {
  globalNotificationManager = manager
}

/**
 * Get the global notification manager.
 */
export function getNotificationManager(): NotificationManager {
  if (!globalNotificationManager) {
    throw new Error('NotificationManager not initialized. Call setNotificationManager() first.')
  }
  return globalNotificationManager
}

/**
 * Create a notification manager.
 */
export function createNotificationManager(
  options?: NotificationManagerOptions
): NotificationManager {
  return new NotificationManager(options)
}
