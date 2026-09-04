import type { Notification } from './Notification'

/**
 * A notification class usable for queue reconstruction. Only the prototype and
 * name are needed: queued notifications are rebuilt with
 * `Object.create(prototype)`, so required constructor arguments are fine.
 */
export interface NotificationConstructor {
  readonly name: string
  readonly prototype: Notification
}

const notificationRegistry = new Map<string, NotificationConstructor>()

/**
 * The registry key for a class, read off the prototype's `type` getter so a
 * class overriding it registers under the key its payloads carry.
 */
function resolveRegistryKey(notificationClass: NotificationConstructor): string {
  try {
    const { type } = Object.create(notificationClass.prototype) as Notification
    if (typeof type === 'string' && type.length > 0) {
      return type
    }
  } catch {
    // A `type` getter depending on instance state cannot be resolved here;
    // fall back to the class name.
  }
  return notificationClass.name
}

/**
 * Register a notification class so queued instances can be rebuilt. Queueing
 * registers automatically, which covers a worker in the same process; a worker
 * in a separate process must register at boot. Type names must be unique — a
 * second class under an existing type replaces the first.
 */
export function registerNotification(
  notificationClass: NotificationConstructor,
  type?: string
): void {
  notificationRegistry.set(
    type ?? resolveRegistryKey(notificationClass),
    notificationClass
  )
}

export function getNotification(
  type: string
): NotificationConstructor | undefined {
  return notificationRegistry.get(type)
}

/** Clear all registered notifications (for testing). */
export function clearNotificationRegistry(): void {
  notificationRegistry.clear()
}
