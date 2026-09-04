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
   * Dispatch to this queue instead of running inline. Requires the Queue
   * system to be configured.
   */
  queue?: string
}

export interface RegisteredListener<T extends Event = Event> {
  listener: EventListener<T>
  options: ListenerOptions
}

export interface EventSubscription {
  unsubscribe(): void
}
