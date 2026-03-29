import type { Event } from './Event'
import type { EventClass } from './types'

/**
 * Base class for event listeners.
 * Extend this class to create reusable, class-based event listeners.
 *
 * @example
 * ```ts
 * class SendWelcomeEmail extends Listener<UserRegistered> {
 *   static event = UserRegistered
 *   static shouldQueue = true
 *   static queue = 'emails'
 *
 *   async handle(event: UserRegistered): Promise<void> {
 *     await mail.to(event.email).subject('Welcome!').send()
 *   }
 *
 *   shouldHandle(event: UserRegistered): boolean {
 *     // Only send to non-admin users
 *     return !event.isAdmin
 *   }
 * }
 * ```
 */
export abstract class Listener<T extends Event = Event> {
  /**
   * The event class this listener handles.
   * Must be set by subclasses.
   */
  static event: EventClass

  /**
   * Whether this listener should be queued instead of executed immediately.
   * @default false
   */
  static shouldQueue = false

  /**
   * The queue name to dispatch to when shouldQueue is true.
   * @default 'default'
   */
  static queue = 'default'

  /**
   * Priority of this listener. Higher values are executed first.
   * @default 0
   */
  static priority = 0

  /**
   * Handle the event.
   * This method must be implemented by subclasses.
   *
   * @param event - The event instance
   */
  abstract handle(event: T): void | Promise<void>

  /**
   * Determine if this listener should handle the event.
   * Override this method to conditionally handle events.
   *
   * @param event - The event instance
   * @returns true if the listener should handle the event
   */
  shouldHandle?(event: T): boolean

  /**
   * Called when the listener fails to handle the event.
   * Override this method to handle errors.
   *
   * @param event - The event instance
   * @param error - The error that occurred
   */
  failed?(event: T, error: Error): void | Promise<void>
}

/**
 * Listener class constructor type.
 */
export interface ListenerClass<T extends Event = Event> {
  new (): Listener<T>
  event: EventClass<T>
  shouldQueue: boolean
  queue: string
  priority: number
}
