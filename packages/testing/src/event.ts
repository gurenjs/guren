import type { Event, EventClass, EventListener, ListenerOptions, EventSubscription } from '@guren/server'

/**
 * Recorded event for testing.
 */
export interface RecordedEvent<T extends Event = Event> {
  eventClass: EventClass<T>
  event: T
  timestamp: Date
}

/**
 * Fake event manager for testing.
 * Captures all emitted events for assertions.
 */
export class FakeEventManager {
  private events: RecordedEvent[] = []
  private listeners = new Map<string, EventListener[]>()

  /**
   * Register a listener for an event.
   */
  on<T extends Event>(
    event: EventClass<T> | string,
    listener: EventListener<T>,
    _options: ListenerOptions = {}
  ): EventSubscription {
    const eventName = typeof event === 'string' ? event : event.eventName
    const eventListeners = this.listeners.get(eventName) ?? []
    eventListeners.push(listener as EventListener)
    this.listeners.set(eventName, eventListeners)

    return {
      unsubscribe: () => this.off(event, listener),
    }
  }

  /**
   * Register a one-time listener for an event.
   */
  once<T extends Event>(
    event: EventClass<T> | string,
    listener: EventListener<T>,
    options: Omit<ListenerOptions, 'once'> = {}
  ): EventSubscription {
    return this.on(event, listener, { ...options, once: true })
  }

  /**
   * Remove a listener for an event.
   */
  off<T extends Event>(event: EventClass<T> | string, listener?: EventListener<T>): void {
    const eventName = typeof event === 'string' ? event : event.eventName
    if (!listener) {
      this.listeners.delete(eventName)
      return
    }

    const eventListeners = this.listeners.get(eventName)
    if (eventListeners) {
      const index = eventListeners.indexOf(listener as EventListener)
      if (index !== -1) {
        eventListeners.splice(index, 1)
      }
    }
  }

  /**
   * Emit an event (records it but does not call listeners by default).
   */
  async emit<T extends Event>(event: T): Promise<void> {
    this.events.push({
      eventClass: event.constructor as EventClass<T>,
      event,
      timestamp: new Date(),
    })
  }

  /**
   * Emit an event in parallel (records it but does not call listeners by default).
   */
  async emitParallel<T extends Event>(event: T): Promise<void> {
    await this.emit(event)
  }

  /**
   * Check if an event has any listeners registered.
   */
  hasListeners(event: EventClass | string): boolean {
    const eventName = typeof event === 'string' ? event : event.eventName
    const listeners = this.listeners.get(eventName)
    return listeners !== undefined && listeners.length > 0
  }

  /**
   * Get all listeners for an event.
   */
  getListeners<T extends Event>(event: EventClass<T> | string): EventListener<T>[] {
    const eventName = typeof event === 'string' ? event : event.eventName
    return (this.listeners.get(eventName) ?? []) as EventListener<T>[]
  }

  /**
   * Get the count of listeners for an event.
   */
  listenerCount(event: EventClass | string): number {
    const eventName = typeof event === 'string' ? event : event.eventName
    return this.listeners.get(eventName)?.length ?? 0
  }

  /**
   * Get all registered event names.
   */
  eventNames(): string[] {
    return Array.from(this.listeners.keys())
  }

  /**
   * Remove all listeners for all events.
   */
  removeAllListeners(): void {
    this.listeners.clear()
  }

  /**
   * Get all recorded events.
   */
  getEvents(): RecordedEvent[] {
    return [...this.events]
  }

  /**
   * Get events of a specific type.
   */
  getEventsOf<T extends Event>(eventClass: EventClass<T>): RecordedEvent<T>[] {
    return this.events.filter(
      (e) => e.eventClass === eventClass || e.eventClass.name === eventClass.name
    ) as RecordedEvent<T>[]
  }

  /**
   * Clear all recorded events.
   */
  clear(): void {
    this.events = []
  }
}

/**
 * Fake event for testing event dispatches.
 */
export class FakeEvent {
  private manager: FakeEventManager

  constructor() {
    this.manager = new FakeEventManager()
  }

  /**
   * Get the underlying manager.
   */
  getManager(): FakeEventManager {
    return this.manager
  }

  /**
   * Record an event dispatch.
   */
  record<T extends Event>(event: T): void {
    this.manager.emit(event)
  }

  /**
   * Assert an event was dispatched.
   */
  assertDispatched<T extends Event>(
    eventClass: EventClass<T>,
    callback?: (event: T) => boolean
  ): void {
    const events = this.manager.getEventsOf(eventClass)

    if (events.length === 0) {
      throw new Error(`Expected event [${eventClass.name}] to be dispatched`)
    }

    if (callback) {
      const match = events.some((e) => callback(e.event))
      if (!match) {
        throw new Error(
          `Expected event [${eventClass.name}] to match callback, but none did`
        )
      }
    }
  }

  /**
   * Assert an event was dispatched a specific number of times.
   */
  assertDispatchedTimes<T extends Event>(eventClass: EventClass<T>, times: number): void {
    const events = this.manager.getEventsOf(eventClass)

    if (events.length !== times) {
      throw new Error(
        `Expected event [${eventClass.name}] to be dispatched ${times} times, got ${events.length}`
      )
    }
  }

  /**
   * Assert an event was not dispatched.
   */
  assertNotDispatched<T extends Event>(eventClass: EventClass<T>): void {
    const events = this.manager.getEventsOf(eventClass)

    if (events.length > 0) {
      throw new Error(
        `Expected event [${eventClass.name}] not to be dispatched, but it was dispatched ${events.length} times`
      )
    }
  }

  /**
   * Assert no events were dispatched.
   */
  assertNothingDispatched(): void {
    const events = this.manager.getEvents()

    if (events.length > 0) {
      const names = [...new Set(events.map((e) => e.eventClass.name))]
      throw new Error(
        `Expected no events to be dispatched, but found: ${names.join(', ')}`
      )
    }
  }

  /**
   * Assert multiple events were dispatched in a specific order.
   */
  assertDispatchedInOrder(eventClasses: EventClass[]): void {
    const events = this.manager.getEvents()

    if (events.length < eventClasses.length) {
      throw new Error(
        `Expected ${eventClasses.length} events in order, but only ${events.length} were dispatched`
      )
    }

    let eventIndex = 0
    for (const eventClass of eventClasses) {
      let found = false
      while (eventIndex < events.length) {
        if (
          events[eventIndex].eventClass === eventClass ||
          events[eventIndex].eventClass.name === eventClass.name
        ) {
          found = true
          eventIndex++
          break
        }
        eventIndex++
      }

      if (!found) {
        throw new Error(
          `Expected event [${eventClass.name}] to be dispatched in order, but it was not found`
        )
      }
    }
  }

  /**
   * Assert an event was dispatched with specific data.
   */
  assertDispatchedWith<T extends Event>(
    eventClass: EventClass<T>,
    data: Partial<T>
  ): void {
    const events = this.manager.getEventsOf(eventClass)

    if (events.length === 0) {
      throw new Error(`Expected event [${eventClass.name}] to be dispatched`)
    }

    const match = events.some((e) => {
      for (const [key, value] of Object.entries(data)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((e.event as any)[key] !== value) {
          return false
        }
      }
      return true
    })

    if (!match) {
      throw new Error(
        `Expected event [${eventClass.name}] to be dispatched with matching data, but none matched`
      )
    }
  }

  /**
   * Get dispatched events of a specific type.
   */
  dispatched<T extends Event>(eventClass: EventClass<T>): RecordedEvent<T>[] {
    return this.manager.getEventsOf(eventClass)
  }

  /**
   * Get all dispatched events.
   */
  all(): RecordedEvent[] {
    return this.manager.getEvents()
  }

  /**
   * Clear all recorded events.
   */
  clear(): void {
    this.manager.clear()
  }
}

/**
 * Create a fake event for testing.
 */
export function fakeEvent(): FakeEvent {
  return new FakeEvent()
}

/**
 * Create a fake event manager for testing.
 * Can be used as a drop-in replacement for EventManager.
 */
export function fakeEventManager(): FakeEventManager {
  return new FakeEventManager()
}
