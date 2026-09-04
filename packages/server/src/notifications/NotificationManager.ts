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

/** Sends notifications through multiple registered channels. */
export class NotificationManager {
  protected channels: Map<string, NotificationChannel> = new Map()
  protected channelFactories: Map<string, NotificationChannelFactory> =
    new Map()
  protected resolvedChannels: Map<string, NotificationChannel> = new Map()

  constructor(options: NotificationManagerOptions = {}) {
    if (options.channels) {
      for (const [name, channel] of Object.entries(options.channels)) {
        this.registerChannel(name, channel)
      }
    }

    if (options.channelFactories) {
      for (const [name, factory] of Object.entries(options.channelFactories)) {
        this.registerChannelFactory(name, factory)
      }
    }
  }

  registerChannel(name: string, channel: NotificationChannel): this {
    this.channels.set(name, channel)
    return this
  }

  registerChannelFactory(
    name: string,
    factory: NotificationChannelFactory
  ): this {
    this.channelFactories.set(name, factory)
    return this
  }

  channel(name: string): NotificationChannel {
    const resolved = this.resolvedChannels.get(name)
    if (resolved) {
      return resolved
    }

    const channel = this.channels.get(name)
    if (channel) {
      return channel
    }

    const factory = this.channelFactories.get(name)
    if (factory) {
      const created = factory({})
      this.resolvedChannels.set(name, created)
      return created
    }

    throw new Error(`Notification channel "${name}" not found`)
  }

  hasChannel(name: string): boolean {
    return (
      this.channels.has(name) ||
      this.channelFactories.has(name) ||
      this.resolvedChannels.has(name)
    )
  }

  getChannelNames(): string[] {
    const names = new Set([
      ...this.channels.keys(),
      ...this.channelFactories.keys(),
      ...this.resolvedChannels.keys(),
    ])
    return Array.from(names)
  }

  /** Send a notification, respecting the queue config on its class. */
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

  /** Send a notification immediately, bypassing the queue. */
  async sendNow(
    notifiable: Notifiable,
    notification: Notification
  ): Promise<void> {
    const shouldSend = await notification.shouldSend(notifiable)
    if (!shouldSend) {
      return
    }

    const viaChannels = notification.via(notifiable)

    await Promise.all(
      viaChannels.map(async (channelName) => {
        try {
          const channel = this.channel(channelName)
          await channel.send(notifiable, notification)
        } catch (error) {
          console.error(
            `Failed to send notification via ${channelName}:`,
            error
          )
          throw error
        }
      })
    )
  }

  protected async queue(
    notifiable: Notifiable,
    notification: Notification,
    queueConfig: { queue?: string; delay?: number }
  ): Promise<void> {
    const job = this.registerQueueJob()

    // So the worker can rebuild a real instance. An explicit
    // registerNotification() is only needed when the worker is another process.
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

    if (queueConfig.delay) {
      await job.dispatchAfter(queueConfig.delay, payload, {
        queue: queueConfig.queue,
      })
    } else {
      await job.dispatch(payload, { queue: queueConfig.queue })
    }
  }

  async sendToMany(
    notifiables: Notifiable[],
    notification: Notification
  ): Promise<void> {
    await Promise.all(
      notifiables.map((notifiable) => this.send(notifiable, notification))
    )
  }

  async sendNowToMany(
    notifiables: Notifiable[],
    notification: Notification
  ): Promise<void> {
    await Promise.all(
      notifiables.map((notifiable) => this.sendNow(notifiable, notification))
    )
  }

  /**
   * Serialize a notifiable for queue storage. Routing is resolved here rather
   * than in the worker: `routeNotificationFor` is arbitrary user code — often a
   * closure on an object literal — and cannot be rebuilt from a payload.
   */
  protected serializeNotifiable(
    notifiable: Notifiable,
    channels: string[] = []
  ): SerializedNotifiable {
    const routes: Record<string, string | null> = {}
    for (const channel of channels) {
      routes[channel] = notifiable.routeNotificationFor(channel)
    }

    return {
      type: resolveNotifiableType(notifiable),
      routes,
      data: { ...notifiable } as Record<string, unknown>,
    }
  }

  /**
   * Serialize a notification for queue storage. Only own enumerable properties
   * are captured; behaviour is restored by rebuilding the registered class in
   * the job handler.
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
   * Bind this manager to the queued-notification job and register it. Call it
   * during boot in a process that runs a worker but may never send a
   * notification itself, or the worker cannot resolve the job.
   */
  registerQueueJob(): typeof SendNotificationJob {
    SendNotificationJob.notificationManager = this
    registerJob(SendNotificationJob)
    return SendNotificationJob
  }
}

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

class SendNotificationJob extends Job<SendNotificationPayload> {
  static jobName = 'SendNotificationJob'
  static queue = 'notifications'
  static maxAttempts = 3

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
   * Rebuild a real notification instance: the class is looked up in the
   * registry and instantiated via its prototype, so prototype methods are
   * restored without running the constructor.
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

let globalNotificationManager: NotificationManager | null = null

export function setNotificationManager(manager: NotificationManager): void {
  globalNotificationManager = manager
}

export function getNotificationManager(): NotificationManager {
  if (!globalNotificationManager) {
    throw new Error('NotificationManager not initialized. Call setNotificationManager() first.')
  }
  return globalNotificationManager
}

export function createNotificationManager(
  options?: NotificationManagerOptions
): NotificationManager {
  return new NotificationManager(options)
}
