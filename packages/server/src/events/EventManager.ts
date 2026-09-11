import { resolveEventName, type Event } from './Event'
import type { ListenerClass } from './Listener'
import { decodeEventData } from './serialize'
import { warnOnce } from '../support/warn-once'
import type {
  EventClass,
  EventListener,
  ListenerOptions,
  QueueEventDispatcher,
  RegisteredListener,
  EventSubscription,
} from './types'

/** Whether the installed dispatcher can reach a queue right now; see {@link EventManager.setQueueDispatcher}. */
type QueueReadiness = () => boolean

/** Registers listeners and emits events. */
export class EventManager {
  private readonly listeners = new Map<string, RegisteredListener[]>()
  /** Classes seen by `on()` or `registerEvent()`, so a queued event can be rebuilt as an instance on the worker. */
  private readonly eventClasses = new Map<string, EventClass>()

  /** Next `listenerSeq` per "<event>\u0000<queue>", never reset; see {@link RegisteredListener.listenerSeq}. */
  private readonly listenerSeqCounters = new Map<string, number>()

  private queueDispatcher?: QueueEventDispatcher
  private queueReadiness?: QueueReadiness

  on<T extends Event>(
    event: EventClass<T> | string,
    listener: EventListener<T>,
    options: ListenerOptions = {}
  ): EventSubscription {
    const eventName = this.nameOf(event)
    if (typeof event !== 'string') {
      this.eventClasses.set(eventName, event)
    }
    const registeredListeners = this.listeners.get(eventName) ?? []

    const registered: RegisteredListener<T> = {
      listener: listener as EventListener,
      options: { once: false, priority: 0, ...options },
      listenerSeq: options.queue === undefined ? undefined : this.nextListenerSeq(eventName, options.queue),
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
   * Makes the class resolvable by name when a queued emit reaches a worker.
   * `on()` registers it too; a worker that only drains the queue registers the
   * listeners anyway, so this is for a process that emits and never listens.
   */
  registerEvent(eventClass: EventClass): void {
    this.eventClasses.set(resolveEventName(eventClass), eventClass)
  }

  /**
   * Registers a `Listener` subclass under its own statics: `event`, `priority`,
   * and `queue` when `shouldQueue`. A `handle()` that throws reaches `failed()`
   * when the class defines it, and propagates either way.
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
          const failure = error instanceof Error ? error : new Error(String(error))
          // failed() is a terminal hook, not a swallow: the queue reads the
          // throw to retry the job and record it as failed.
          if (instance.failed) await instance.failed(event, failure)
          throw failure
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
    const eventName = this.nameOf(event)
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
    await this.dispatch(event, false)
  }

  /** {@link emit} without the ordering guarantee. */
  async emitParallel<T extends Event>(event: T): Promise<void> {
    await this.dispatch(event, true)
  }

  private async dispatch<T extends Event>(event: T, parallel: boolean): Promise<void> {
    const eventName = event.eventName
    const registeredListeners = this.listeners.get(eventName)

    if (!registeredListeners || registeredListeners.length === 0) {
      return
    }

    const listenersToCall = [...registeredListeners]
    const toRemove: RegisteredListener[] = []

    const call = async (registered: RegisteredListener): Promise<void> => {
      const queued = await this.invoke(registered, event, eventName)
      // A queued `once` listener is removed once it has *run*, which is on the
      // worker; removing it here would drop it before the job is drained.
      if (registered.options.once && !queued) {
        toRemove.push(registered)
      }
    }

    if (parallel) {
      await Promise.all(listenersToCall.map(call))
    } else {
      for (const registered of listenersToCall) {
        await call(registered)
      }
    }

    this.forget(eventName, registeredListeners, toRemove)
  }

  /** Resolves whether the listener was sent to a queue rather than run here. */
  private async invoke(registered: RegisteredListener, event: Event, eventName: string): Promise<boolean> {
    const queue = registered.options.queue
    if (!queue) {
      await registered.listener(event)
      return false
    }

    const dispatcher = this.queueDispatcher
    if (!dispatcher || (this.queueReadiness && !this.queueReadiness())) {
      warnOnce(
        `event-queue-unwired:${eventName}:${queue}`,
        `[guren] A listener for "${eventName}" is registered with queue "${queue}", but no queue is reachable ` +
          'from this EventManager, so it ran inline. Bind a QueueManager as "queue" (QueueServiceProvider) and ' +
          'register a driver, or call setQueueDispatcher(createQueueEventDispatcher()) on a manager you build ' +
          'yourself. A future major will throw here instead of running the listener inline.',
      )
      await registered.listener(event)
      return false
    }

    await dispatcher(queue, eventName, event, registered.listenerSeq)
    return true
  }

  /**
   * Counted per event and queue, so an inline listener registered beside them
   * does not move the numbers. The worker counts its own the same way, which is
   * why both processes must register the queued listeners in the same order.
   */
  private nextListenerSeq(eventName: string, queue: string): number {
    const key = `${eventName}\u0000${queue}`
    const next = this.listenerSeqCounters.get(key) ?? 0
    this.listenerSeqCounters.set(key, next + 1)
    return next
  }

  private onQueue(eventName: string, queue: string): RegisteredListener[] {
    return (this.listeners.get(eventName) ?? []).filter((r) => r.options.queue === queue)
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
   * The worker side of a queued emit: runs the listener the message names,
   * with the event rebuilt as an instance of the registered class. An absent
   * `listenerSeq` — a dispatcher of your own that does not send one — runs
   * every listener for that event on that queue.
   */
  async handleQueued(
    queueName: string,
    eventName: string,
    data: Record<string, unknown>,
    listenerSeq?: number,
  ): Promise<void> {
    const onQueue = this.onQueue(eventName, queueName)
    const named = listenerSeq === undefined ? undefined : onQueue.find((r) => r.listenerSeq === listenerSeq)

    if (listenerSeq !== undefined && named === undefined) {
      throw new Error(
        `Queued event "${eventName}" names listener ${listenerSeq} on queue "${queueName}", but this process has ` +
          `no listener registered under that number (${onQueue.length} on that queue). The worker must register ` +
          'the same queued listeners, in the same order, as the process that emitted.',
      )
    }

    const event = this.rehydrate(eventName, data)
    const toRun = named === undefined ? onQueue : [named]

    for (const registered of toRun) {
      await registered.listener(event)
      // Removed now rather than at dispatch: a `once` listener has run only here.
      if (registered.options.once) this.off(eventName, registered.listener)
    }
  }

  private rehydrate(eventName: string, data: Record<string, unknown>): Event {
    const eventClass = this.eventClasses.get(eventName)
    if (!eventClass) {
      throw new Error(
        `No event class is registered for "${eventName}", so the queued message cannot be rebuilt. ` +
          'Register it with events.registerEvent(EventClass) in the worker process, or listen for the class ' +
          'itself rather than the name. Pin the name with `static eventName` if the class may be renamed.',
      )
    }

    const event = Object.create(eventClass.prototype) as Record<string, unknown>
    Object.assign(event, decodeEventData(data))
    // A message written before the tagged encoding, or by a dispatcher of your own.
    if (typeof event.timestamp === 'string') {
      event.timestamp = new Date(event.timestamp)
    }
    return event as unknown as Event
  }

  hasListeners(event: EventClass | string): boolean {
    const listeners = this.listeners.get(this.nameOf(event))
    return listeners !== undefined && listeners.length > 0
  }

  getListeners<T extends Event>(event: EventClass<T> | string): EventListener<T>[] {
    const registeredListeners = this.listeners.get(this.nameOf(event))
    if (!registeredListeners) return []
    return registeredListeners.map((r) => r.listener) as EventListener<T>[]
  }

  listenerCount(event: EventClass | string): number {
    return this.listeners.get(this.nameOf(event))?.length ?? 0
  }

  eventNames(): string[] {
    return Array.from(this.listeners.keys())
  }

  removeAllListeners(): void {
    this.listeners.clear()
    this.eventClasses.clear()
    // The queue counters deliberately survive: resetting them would renumber
    // re-registered listeners onto numbers messages already in flight carry,
    // so one of those would run the wrong listener instead of being refused.
  }

  /**
   * `EventServiceProvider` installs `createQueueEventDispatcher()` at boot.
   * `canQueue` is asked per emit: the dispatcher is installed before the app's
   * queue driver necessarily exists, and a listener whose queue is unreachable
   * runs inline rather than failing the emit.
   */
  setQueueDispatcher(dispatcher: QueueEventDispatcher, canQueue?: QueueReadiness): void {
    this.queueDispatcher = dispatcher
    this.queueReadiness = canQueue
  }

  private nameOf(event: EventClass | string): string {
    return typeof event === 'string' ? event : resolveEventName(event)
  }
}

export function createEventManager(): EventManager {
  return new EventManager()
}
