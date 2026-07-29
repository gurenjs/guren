import type {
  Notifiable,
  NotificationChannel,
  NotificationChannelFactory,
  NotificationManagerOptions,
  NotificationClass,
} from './types'
import type { Notification } from './Notification'
import {
  registerNotification,
  getNotification,
  type NotificationConstructor,
} from './registry'
import { resolveNotifiableType } from './notifiable-type'
import { Job, registerJob } from '../queue'

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
    const job = this.registerQueueJob()

    // Register the notification class so the worker can rebuild a real
    // instance. Explicit registerNotification() is only needed when the worker
    // runs in a separate process from the dispatch.
    registerNotification(
      notification.constructor as NotificationConstructor,
      notification.type
    )

    const payload: SendNotificationPayload = {
      notifiableData: this.serializeNotifiable(
        notifiable,
        notification.via(notifiable)
      ),
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
   *
   * Routing is resolved here rather than in the worker: `routeNotificationFor`
   * is arbitrary user code — often a closure on an object literal — and cannot
   * be reconstructed from a payload.
   *
   * @param channels - Channels to resolve routes for
   */
  protected serializeNotifiable(
    notifiable: Notifiable,
    channels: string[] = []
  ): SerializedNotifiable {
    const routes: Record<string, string | null> = {}
    for (const channel of channels) {
      routes[channel] = notifiable.routeNotificationFor(channel)
    }

    // Basic serialization - can be overridden for custom behavior
    return {
      type: resolveNotifiableType(notifiable),
      routes,
      data: { ...notifiable } as Record<string, unknown>,
    }
  }

  /**
   * Serialize notification for queue storage.
   *
   * Only own enumerable properties are captured. Behaviour is restored by
   * rebuilding the registered class in the job handler, not by serializing it.
   */
  protected serializeNotification(
    notification: Notification
  ): SerializedNotification {
    return {
      id: notification.id,
      createdAt: notification.createdAt.toISOString(),
      data: { ...notification } as Record<string, unknown>,
    }
  }

  /**
   * Bind this manager to the queued-notification job and register it.
   *
   * Call this during boot in a process that runs a worker but may never send
   * a notification itself: without it, the worker cannot resolve the job.
   */
  registerQueueJob(): typeof SendNotificationJob {
    SendNotificationJob.notificationManager = this
    registerJob(SendNotificationJob)
    return SendNotificationJob
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
  /** Channel routes resolved at dispatch time. Absent on legacy payloads. */
  routes?: Record<string, string | null>
  data: Record<string, unknown>
}

interface SerializedNotification {
  id: string
  createdAt: string
  data: Record<string, unknown>
}

/**
 * Job for sending queued notifications.
 */
class SendNotificationJob extends Job<SendNotificationPayload> {
  static queue = 'notifications'
  static maxAttempts = 3

  // Will be set by NotificationManager
  static notificationManager: NotificationManager | null = null

  async handle(payload: SendNotificationPayload): Promise<void> {
    const manager = (this.constructor as typeof SendNotificationJob).notificationManager
    if (!manager) {
      throw new Error('NotificationManager not set on SendNotificationJob')
    }

    const notifiable = this.rebuildNotifiable(payload.notifiableData)
    const notification = this.rebuildNotification(
      payload.notificationType,
      payload.notificationData
    )

    await manager.sendNow(notifiable, notification)
  }

  /**
   * Rebuild the notifiable from its serialized data.
   */
  protected rebuildNotifiable(serialized: SerializedNotifiable): Notifiable {
    const { data, routes } = serialized

    return {
      ...data,
      notifiableType: serialized.type,
      routeNotificationFor(channel: string): string | null {
        if (routes && channel in routes) {
          return routes[channel] ?? null
        }

        // Legacy payloads carry no routes: fall back to the conventions the
        // previous implementation guessed at.
        const value = data[`${channel}Route`]
        if (typeof value === 'string') return value

        if (channel === 'mail') {
          const email = data['email']
          return typeof email === 'string' ? email : null
        }
        return null
      },
    }
  }

  /**
   * Rebuild a real notification instance from its serialized data.
   *
   * The class is looked up in the notification registry and instantiated via
   * its prototype, so prototype methods (`via`, `toMail`, `toDatabase`,
   * `toSlack`, `shouldSend`) are restored without running the constructor.
   */
  protected rebuildNotification(
    type: string,
    serialized: SerializedNotification
  ): Notification {
    const NotificationClass = getNotification(type)
    if (!NotificationClass) {
      throw new Error(
        `Notification type "${type}" is not registered. ` +
          `Call registerNotification(${type}) before running the queue worker.`
      )
    }

    // createdAt is revived explicitly: queue drivers that persist JSON turn
    // Dates into strings.
    return Object.assign(
      Object.create(NotificationClass.prototype) as Notification,
      serialized.data,
      { id: serialized.id, createdAt: new Date(serialized.createdAt) }
    )
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
