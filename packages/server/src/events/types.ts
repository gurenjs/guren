import type { Event } from './Event'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface EventClass<T extends Event = Event> {
  new (...args: any[]): T
  eventName: string
}

export type EventListener<T extends Event = Event> = (event: T) => void | Promise<void>

export interface ListenerOptions {
  /**
   * Removed after its first invocation.
   * @default false
   */
  once?: boolean

  /**
   * Higher runs first.
   * @default 0
   */
  priority?: number

  /**
   * Dispatch to this queue instead of running inline. A manager that cannot
   * reach a queue warns once and runs the listener inline.
   */
  queue?: string
}

/**
 * Sends one queued listener's emit; `event` is the live instance, serialized by
 * the dispatcher. `listenerIndex` identifies the listener among those on that
 * queue — a dispatcher that drops it makes the worker run all of them.
 */
export type QueueEventDispatcher = (
  queueName: string,
  eventName: string,
  event: Event,
  listenerIndex?: number,
) => Promise<void>

export interface RegisteredListener<T extends Event = Event> {
  listener: EventListener<T>
  options: ListenerOptions
}

export interface EventSubscription {
  unsubscribe(): void
}
