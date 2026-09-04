import type { Event } from './Event'
import type { EventClass } from './types'

/** Base class for reusable, class-based event listeners. */
export abstract class Listener<T extends Event = Event> {
  /** Must be set by subclasses. */
  static event: EventClass

  /** @default false */
  static shouldQueue = false

  /**
   * Used when `shouldQueue`.
   * @default 'default'
   */
  static queue = 'default'

  /**
   * Higher runs first.
   * @default 0
   */
  static priority = 0

  abstract handle(event: T): void | Promise<void>

  /** Optional filter: return false to skip the event. */
  shouldHandle?(event: T): boolean

  /** Called when `handle` throws. */
  failed?(event: T, error: Error): void | Promise<void>
}

export interface ListenerClass<T extends Event = Event> {
  new (): Listener<T>
  event: EventClass<T>
  shouldQueue: boolean
  queue: string
  priority: number
}
