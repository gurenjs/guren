import type { Event } from './Event'
import type {
  EventClass,
  EventListener,
  ListenerOptions,
  RegisteredListener,
  EventSubscription,
} from './types'

/** Registers listeners and emits events. */
export class EventManager {
  private readonly listeners = new Map<string, RegisteredListener[]>()

  private queueDispatcher?: (queueName: string, eventName: string, event: Event) => Promise<void>

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

    registeredListeners.sort((a, b) => (b.options.priority ?? 0) - (a.options.priority ?? 0))

    this.listeners.set(eventName, registeredListeners)

    return {
      unsubscribe: () => this.off(event, listener),
    }
  }

  once<T extends Event>(
    event: EventClass<T> | string,
    listener: EventListener<T>,
    options: Omit<ListenerOptions, 'once'> = {}
  ): EventSubscription {
    return this.on(event, listener, { ...options, once: true })
  }

  /** Omitting `listener` removes every listener for the event. */
  off<T extends Event>(event: EventClass<T> | string, listener?: EventListener<T>): void {
    const eventName = typeof event === 'string' ? event : event.eventName
    const registeredListeners = this.listeners.get(eventName)

    if (!registeredListeners) return

    if (!listener) {
      this.listeners.delete(eventName)
      return
    }

    const index = registeredListeners.findIndex((r) => r.listener === listener)
    if (index !== -1) {
      registeredListeners.splice(index, 1)
      if (registeredListeners.length === 0) {
        this.listeners.delete(eventName)
      }
    }
  }

  /** Highest priority first, awaited one at a time. */
  async emit<T extends Event>(event: T): Promise<void> {
    const eventName = event.eventName
    const registeredListeners = this.listeners.get(eventName)

    if (!registeredListeners || registeredListeners.length === 0) {
      return
    }

    const listenersToCall = [...registeredListeners]
    const toRemove: RegisteredListener[] = []

    for (const registered of listenersToCall) {
      if (registered.options.queue && this.queueDispatcher) {
        await this.queueDispatcher(registered.options.queue, eventName, event)
      } else {
        await registered.listener(event)
      }

      if (registered.options.once) {
        toRemove.push(registered)
      }
    }

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

  /** {@link emit} without the ordering guarantee. */
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

  hasListeners(event: EventClass | string): boolean {
    const eventName = typeof event === 'string' ? event : event.eventName
    const listeners = this.listeners.get(eventName)
    return listeners !== undefined && listeners.length > 0
  }

  getListeners<T extends Event>(event: EventClass<T> | string): EventListener<T>[] {
    const eventName = typeof event === 'string' ? event : event.eventName
    const registeredListeners = this.listeners.get(eventName)
    if (!registeredListeners) return []
    return registeredListeners.map((r) => r.listener) as EventListener<T>[]
  }

  listenerCount(event: EventClass | string): number {
    const eventName = typeof event === 'string' ? event : event.eventName
    return this.listeners.get(eventName)?.length ?? 0
  }

  eventNames(): string[] {
    return Array.from(this.listeners.keys())
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }

  /** Called by the Queue system when it is integrated. */
  setQueueDispatcher(
    dispatcher: (queueName: string, eventName: string, event: Event) => Promise<void>
  ): void {
    this.queueDispatcher = dispatcher
  }
}

export function createEventManager(): EventManager {
  return new EventManager()
}
