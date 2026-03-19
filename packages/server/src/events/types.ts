import type { Event } from './Event'

/**
 * Event class constructor type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface EventClass<T extends Event = Event> {
  new (...args: any[]): T
  eventName: string
}

/**
 * Event listener function type.
 */
export type EventListener<T extends Event = Event> = (event: T) => void | Promise<void>

/**
 * Options for registering an event listener.
 */
export interface ListenerOptions {
  /**
   * If true, the listener will be removed after the first invocation.
   * @default false
   */
  once?: boolean

  /**
   * Priority of the listener. Higher values are executed first.
   * @default 0
   */
  priority?: number

  /**
   * If specified, the listener will be dispatched to a queue instead of being executed immediately.
   * Requires the Queue system to be configured.
   */
  queue?: string
}

/**
 * Internal representation of a registered listener.
 */
export interface RegisteredListener<T extends Event = Event> {
  listener: EventListener<T>
  options: ListenerOptions
}

/**
 * Event subscription handle for unsubscribing.
 */
export interface EventSubscription {
  /**
   * Unsubscribe the listener.
   */
  unsubscribe(): void
}
