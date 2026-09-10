import type { Event } from './Event'
import type { ListenerClass } from './Listener'
import type {
  EventClass,
  EventListener,
  ListenerOptions,
  QueueEventDispatcher,
  RegisteredListener,
  EventSubscription,
} from './types'

/** Registers listeners and emits events. */
export class EventManager {
  private readonly listeners = new Map<string, RegisteredListener[]>()
  /** Classes seen by `on()`, so a queued event can be rebuilt as an instance on the worker. */
  private readonly eventClasses = new Map<string, EventClass>()

  private queueDispatcher?: QueueEventDispatcher

  on<T extends Event>(
    event: EventClass<T> | string,
    listener: EventListener<T>,
    options: ListenerOptions = {}
  ): EventSubscription {
    const eventName = typeof event === 'string' ? event : event.eventName
    if (typeof event !== 'string') {
      this.eventClasses.set(eventName, event)
    }
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

  /**
   * Registers a `Listener` subclass under its own statics: `event`, `priority`,
   * and `queue` when `shouldQueue`. A `handle()` that throws reaches `failed()`
   * when the class defines it, and propagates otherwise.
   */
  listen<T extends Event>(listenerClass: ListenerClass<T>): EventSubscription {
    const instance = new listenerClass()

    return this.on(
      listenerClass.event,
      async (event) => {
        if (instance.shouldHandle && !instance.shouldHandle(event)) return
        try {
          await instance.handle(event)
        } catch (error) {
          if (!instance.failed) throw error
          await instance.failed(event, error instanceof Error ? error : new Error(String(error)))
        }
      },
      {
        priority: listenerClass.priority,
        queue: listenerClass.shouldQueue ? listenerClass.queue : undefined,
      },
    )
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
    const dispatchedQueues = new Set<string>()

    for (const registered of listenersToCall) {
      await this.invoke(registered, event, dispatchedQueues)

      if (registered.options.once) {
        toRemove.push(registered)
      }
    }

    this.forget(eventName, registeredListeners, toRemove)
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
    const dispatchedQueues = new Set<string>()

    await Promise.all(
      listenersToCall.map(async (registered) => {
        await this.invoke(registered, event, dispatchedQueues)

        if (registered.options.once) {
          toRemove.push(registered)
        }
      })
    )

    this.forget(eventName, registeredListeners, toRemove)
  }

  /**
   * A queued listener sends one message per queue per emit rather than one per
   * listener: the worker runs every listener on that queue, so a message per
   * listener would run each of them once per listener.
   */
  private async invoke(registered: RegisteredListener, event: Event, dispatchedQueues: Set<string>): Promise<void> {
    const queue = registered.options.queue
    if (!queue) {
      await registered.listener(event)
      return
    }

    if (!this.queueDispatcher) {
      throw new Error(
        `A listener for "${event.eventName}" is registered with queue "${queue}", but this EventManager has no queue dispatcher. ` +
          'Bind a QueueManager as "queue" (QueueServiceProvider) so EventServiceProvider wires one, ' +
          'or call setQueueDispatcher(createQueueEventDispatcher()) on the manager you build yourself.',
      )
    }

    // Claimed before the await, so emitParallel() cannot send the same queue twice.
    if (dispatchedQueues.has(queue)) return
    dispatchedQueues.add(queue)
    await this.queueDispatcher(queue, event.eventName, event)
  }

  private forget(eventName: string, registeredListeners: RegisteredListener[], toRemove: RegisteredListener[]): void {
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
   * The worker side of a queued emit: runs the listeners registered for
   * `eventName` on `queueName` inline, with the event rebuilt from its
   * serialized fields (an instance of the class `on()` saw, else a plain object).
   */
  async handleQueued(queueName: string, eventName: string, data: Record<string, unknown>): Promise<void> {
    const event = this.rehydrate(eventName, data)
    const registeredListeners = (this.listeners.get(eventName) ?? []).filter(
      (registered) => registered.options.queue === queueName,
    )

    for (const registered of registeredListeners) {
      await registered.listener(event)
    }
  }

  private rehydrate(eventName: string, data: Record<string, unknown>): Event {
    const eventClass = this.eventClasses.get(eventName)
    const event = (eventClass ? Object.create(eventClass.prototype) : { eventName }) as Record<string, unknown>
    Object.assign(event, data)
    // JSON turned the Date into an ISO string on a driver that serializes.
    if (typeof event.timestamp === 'string') {
      event.timestamp = new Date(event.timestamp)
    }
    return event as unknown as Event
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

  /** `EventServiceProvider` sets `createQueueEventDispatcher()` when the app binds a `queue` manager. */
  setQueueDispatcher(dispatcher: QueueEventDispatcher): void {
    this.queueDispatcher = dispatcher
  }

  hasQueueDispatcher(): boolean {
    return this.queueDispatcher !== undefined
  }
}

export function createEventManager(): EventManager {
  return new EventManager()
}
