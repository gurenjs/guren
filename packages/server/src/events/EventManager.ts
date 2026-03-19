import type { Event } from './Event'
import type {
  EventClass,
  EventListener,
  ListenerOptions,
  RegisteredListener,
  EventSubscription,
} from './types'

/**
 * Event manager for registering listeners and emitting events.
 *
 * @example
 * ```ts
 * const events = new EventManager()
 *
 * // Register a listener
 * events.on(UserRegistered, async (event) => {
 *   console.log(`User ${event.userId} registered`)
 *   await sendWelcomeEmail(event.email)
 * })
 *
 * // Register a one-time listener
 * events.once(AppStarted, () => {
 *   console.log('App started!')
 * })
 *
 * // Emit an event
 * await events.emit(new UserRegistered('123', 'user@example.com'))
 * ```
 */
export class EventManager {
  private readonly listeners = new Map<string, RegisteredListener[]>()

  /**
   * Queue dispatcher function (set when Queue system is integrated).
   */
  private queueDispatcher?: (queueName: string, eventName: string, event: Event) => Promise<void>

  /**
   * Register a listener for an event.
   *
   * @param event - Event class to listen for
   * @param listener - Listener function
   * @param options - Listener options
   * @returns Subscription handle for unsubscribing
   *
   * @example
   * ```ts
   * // Basic usage
   * events.on(UserRegistered, (e) => console.log(e.email))
   *
   * // With options
   * events.on(UserRegistered, (e) => sendEmail(e), { priority: 10 })
   *
   * // Unsubscribe later
   * const sub = events.on(UserRegistered, handler)
   * sub.unsubscribe()
   * ```
   */
  on<T extends Event>(
    event: EventClass<T> | string,
    listener: EventListener<T>,
    options: ListenerOptions = {}
  ): EventSubscription {
    const eventName = typeof event === 'string' ? event : event.eventName
    const registeredListeners = this.listeners.get(eventName) ?? []

    const registered: RegisteredListener<T> = {
      listener: listener as EventListener,
      options: { once: false, priority: 0, ...options },
    }

    registeredListeners.push(registered as RegisteredListener)

    // Sort by priority (higher first)
    registeredListeners.sort((a, b) => (b.options.priority ?? 0) - (a.options.priority ?? 0))

    this.listeners.set(eventName, registeredListeners)

    return {
      unsubscribe: () => this.off(event, listener),
    }
  }

  /**
   * Register a one-time listener for an event.
   * The listener will be automatically removed after the first invocation.
   *
   * @param event - Event class to listen for
   * @param listener - Listener function
   * @param options - Additional listener options (once is always true)
   * @returns Subscription handle for unsubscribing
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
   *
   * @param event - Event class
   * @param listener - Listener to remove (if omitted, all listeners for the event are removed)
   */
  off<T extends Event>(event: EventClass<T> | string, listener?: EventListener<T>): void {
    const eventName = typeof event === 'string' ? event : event.eventName
    const registeredListeners = this.listeners.get(eventName)

    if (!registeredListeners) return

    if (!listener) {
      // Remove all listeners for this event
      this.listeners.delete(eventName)
      return
    }

    // Remove specific listener
    const index = registeredListeners.findIndex((r) => r.listener === listener)
    if (index !== -1) {
      registeredListeners.splice(index, 1)
      if (registeredListeners.length === 0) {
        this.listeners.delete(eventName)
      }
    }
  }

  /**
   * Emit an event to all registered listeners.
   * Listeners are executed in order of priority (highest first).
   * Async listeners are awaited sequentially.
   *
   * @param event - Event instance to emit
   *
   * @example
   * ```ts
   * await events.emit(new UserRegistered('123', 'user@example.com'))
   * ```
   */
  async emit<T extends Event>(event: T): Promise<void> {
    const eventName = event.eventName
    const registeredListeners = this.listeners.get(eventName)

    if (!registeredListeners || registeredListeners.length === 0) {
      return
    }

    // Create a copy to handle once listeners being removed during iteration
    const listenersToCall = [...registeredListeners]
    const toRemove: RegisteredListener[] = []

    for (const registered of listenersToCall) {
      // Handle queue dispatch
      if (registered.options.queue && this.queueDispatcher) {
        await this.queueDispatcher(registered.options.queue, eventName, event)
      } else {
        await registered.listener(event)
      }

      if (registered.options.once) {
        toRemove.push(registered)
      }
    }

    // Remove once listeners
    for (const registered of toRemove) {
      const index = registeredListeners.indexOf(registered)
      if (index !== -1) {
        registeredListeners.splice(index, 1)
      }
    }

    if (registeredListeners.length === 0) {
      this.listeners.delete(eventName)
    }
  }

  /**
   * Emit an event to all registered listeners in parallel.
   * Use this when listener execution order doesn't matter and you want faster execution.
   *
   * @param event - Event instance to emit
   */
  async emitParallel<T extends Event>(event: T): Promise<void> {
    const eventName = event.eventName
    const registeredListeners = this.listeners.get(eventName)

    if (!registeredListeners || registeredListeners.length === 0) {
      return
    }

    const listenersToCall = [...registeredListeners]
    const toRemove: RegisteredListener[] = []

    await Promise.all(
      listenersToCall.map(async (registered) => {
        if (registered.options.queue && this.queueDispatcher) {
          await this.queueDispatcher(registered.options.queue, eventName, event)
        } else {
          await registered.listener(event)
        }

        if (registered.options.once) {
          toRemove.push(registered)
        }
      })
    )

    // Remove once listeners
    for (const registered of toRemove) {
      const index = registeredListeners.indexOf(registered)
      if (index !== -1) {
        registeredListeners.splice(index, 1)
      }
    }

    if (registeredListeners.length === 0) {
      this.listeners.delete(eventName)
    }
  }

  /**
   * Check if an event has any listeners registered.
   *
   * @param event - Event class or event name
   */
  hasListeners(event: EventClass | string): boolean {
    const eventName = typeof event === 'string' ? event : event.eventName
    const listeners = this.listeners.get(eventName)
    return listeners !== undefined && listeners.length > 0
  }

  /**
   * Get all listeners for an event.
   *
   * @param event - Event class or event name
   */
  getListeners<T extends Event>(event: EventClass<T> | string): EventListener<T>[] {
    const eventName = typeof event === 'string' ? event : event.eventName
    const registeredListeners = this.listeners.get(eventName)
    if (!registeredListeners) return []
    return registeredListeners.map((r) => r.listener) as EventListener<T>[]
  }

  /**
   * Get the count of listeners for an event.
   *
   * @param event - Event class or event name
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
   * Set the queue dispatcher function.
   * This is called by the Queue system when it's integrated.
   */
  setQueueDispatcher(
    dispatcher: (queueName: string, eventName: string, event: Event) => Promise<void>
  ): void {
    this.queueDispatcher = dispatcher
  }
}

/**
 * Create a new EventManager instance.
 */
export function createEventManager(): EventManager {
  return new EventManager()
}
