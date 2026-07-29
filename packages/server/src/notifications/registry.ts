import type { Notification } from './Notification'

/**
 * A notification class usable for queue reconstruction.
 *
 * Only the prototype and name are required: queued notifications are rebuilt
 * with `Object.create(prototype)` and never constructed, so classes with
 * required constructor arguments are supported.
 */
export interface NotificationConstructor {
  readonly name: string
  readonly prototype: Notification
}

const notificationRegistry = new Map<string, NotificationConstructor>()

/**
 * Resolve the registry key for a class without constructing it.
 *
 * Reads the `type` getter off the prototype so a class overriding it registers
 * under the same key the dispatched payload carries.
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
 * Register a notification class so queued instances can be rebuilt.
 *
 * Notifications are registered automatically when they are queued, which
 * covers delivery by a worker running in the same process. A worker running
 * in a separate process must register them explicitly at boot.
 *
 * Type names must be unique within an application: as with the job registry,
 * registering a second class under an existing type replaces the first.
 *
 * @param notificationClass - The notification class to register
 * @param type - Registry key, defaulting to the class's own `type` value
 *
 * @example
 * ```typescript
 * registerNotification(OrderShipped)
 * ```
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

/**
 * Get a registered notification class by type.
 */
export function getNotification(
  type: string
): NotificationConstructor | undefined {
  return notificationRegistry.get(type)
}

/**
 * Clear all registered notifications (for testing).
 */
export function clearNotificationRegistry(): void {
  notificationRegistry.clear()
}
