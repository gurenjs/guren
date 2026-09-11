import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Application } from '../../src/http/Application'
import { ServiceProvider } from '../../src/container/ServiceProvider'
import { EventServiceProvider } from '../../src/providers/EventServiceProvider'
import { Event, EventManager, Listener, createEventManager, createQueueEventDispatcher } from '../../src/events'
import { MemoryDriver, Worker, clearQueueDriver, getJob, setQueueDriver, createQueueManager } from '../../src/queue'
import { bootWithMemoryQueue, resetQueueState } from '../queue/helpers'
import { captureWarnings } from '../support/warnings'
import { resetWarnOnce } from '../../src/support/warn-once'

class OrderPlaced extends Event {
  constructor(public readonly orderId: string, public readonly placedAt: Date = new Date()) {
    super()
  }
}

function drain(driver: MemoryDriver, queue: string): Promise<void> {
  return new Worker(driver, { queues: [queue], sleep: 0, stopWhenEmpty: true }).start()
}

describe('queued listeners through the providers', () => {
  let driver: MemoryDriver

  beforeEach(() => {
    driver = new MemoryDriver()
    clearQueueDriver()
    resetWarnOnce()
  })

  afterEach(() => {
    resetQueueState()
  })

  function bootWithQueue(): Promise<Application> {
    return bootWithMemoryQueue(driver, [EventServiceProvider])
  }

  it('pushes the emit onto the queue and runs the listener when a worker drains it', async () => {
    const app = await bootWithQueue()

    const events = app.container.make('events')
    const handled: OrderPlaced[] = []
    const inline: string[] = []
    events.on(OrderPlaced, (event) => { handled.push(event) }, { queue: 'emails' })
    events.on(OrderPlaced, (event) => { inline.push(event.orderId) })

    const placedAt = new Date('2026-01-02T03:04:05.000Z')
    await events.emit(new OrderPlaced('o-1', placedAt))

    expect(inline).toEqual(['o-1'])
    expect(handled).toEqual([])
    expect(await driver.size('emails')).toBe(1)

    await drain(driver, 'emails')

    expect(handled).toHaveLength(1)
    expect(handled[0]).toBeInstanceOf(OrderPlaced)
    expect(handled[0].orderId).toBe('o-1')
    // The Date survives the round trip; JSON alone would hand back a string.
    expect(handled[0].placedAt).toEqual(placedAt)
    expect(handled[0].timestamp).toBeInstanceOf(Date)
    expect(await driver.size('emails')).toBe(0)
  })

  it('runs the listener inline, warning once, when the app binds no queue', async () => {
    const app = new Application({ providers: [EventServiceProvider] })
    await app.boot()

    const events = app.container.make('events')
    const handled: string[] = []
    events.on(OrderPlaced, (event) => { handled.push(event.orderId) }, { queue: 'emails' })

    const warnings = await captureWarnings(async () => {
      await events.emit(new OrderPlaced('o-2'))
      await events.emit(new OrderPlaced('o-3'))
    })

    expect(handled).toEqual(['o-2', 'o-3'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('setQueueDispatcher(createQueueEventDispatcher())')
  })

  it('queues through a driver set by hand, with EventServiceProvider as the only provider', async () => {
    const app = new Application({ providers: [EventServiceProvider] })
    await app.boot()
    setQueueDriver(driver)

    const events = app.container.make('events')
    const handled: string[] = []
    events.on(OrderPlaced, (event) => { handled.push(event.orderId) }, { queue: 'emails' })

    await events.emit(new OrderPlaced('o-4'))
    expect(handled).toEqual([])

    await drain(driver, 'emails')
    expect(handled).toEqual(['o-4'])
  })

  it('reaches a queue bound by a provider registered after EventServiceProvider', async () => {
    class LateQueueProvider extends ServiceProvider {
      register(): void {
        this.container.singleton('queue', () =>
          createQueueManager({ default: 'memory', drivers: { memory: () => driver } }),
        )
      }
    }

    const app = new Application({ providers: [EventServiceProvider, LateQueueProvider] })
    await app.boot()

    const events = app.container.make('events')
    const handled: string[] = []
    events.on(OrderPlaced, (event) => { handled.push(event.orderId) }, { queue: 'emails' })

    await events.emit(new OrderPlaced('o-5'))
    expect(await driver.size('emails')).toBe(1)

    await drain(driver, 'emails')
    expect(handled).toEqual(['o-5'])
  })

  it('retries only the listener that threw, rather than completing its job or re-running the others', async () => {
    const app = await bootWithQueue()

    const events = app.container.make('events')
    const ran: string[] = []
    class Flaky extends Listener<OrderPlaced> {
      static override event = OrderPlaced
      static override shouldQueue = true
      static override queue = 'emails'
      handle(): void {
        ran.push('flaky')
        throw new Error('smtp down')
      }
    }
    events.on(OrderPlaced, () => { ran.push('steady') }, { queue: 'emails' })
    events.listen(Flaky)

    await events.emit(new OrderPlaced('o-6'))
    expect(await driver.size('emails')).toBe(2)

    await drain(driver, 'emails')

    // Each listener has its own message: the steady one completed, the flaky
    // one went back on the queue for its retry rather than being marked done.
    expect(ran).toEqual(['steady', 'flaky'])
    expect(await driver.size('emails')).toBe(1)
    expect(await driver.getFailedJobs()).toEqual([])
  })

  it('calls a queued listener failed() once the job has run out of retries', async () => {
    const app = await bootWithQueue()

    const events = app.container.make('events')
    const attempts: string[] = []
    const failures: string[] = []
    class Flaky extends Listener<OrderPlaced> {
      static override event = OrderPlaced
      static override shouldQueue = true
      static override queue = 'emails'
      handle(event: OrderPlaced): void {
        attempts.push(event.orderId)
        throw new Error('smtp down')
      }
      override failed(event: OrderPlaced, error: Error): void {
        failures.push(`${event.orderId}:${error.message}`)
      }
    }
    events.listen(Flaky)

    // One attempt, so the run below reaches the exhausted branch without
    // waiting out the carrier job's exponential backoff.
    const carrier = getJob('QueuedEventJob')!
    const maxAttempts = carrier.maxAttempts
    carrier.maxAttempts = 1
    try {
      await events.emit(new OrderPlaced('o-12'))
      await drain(driver, 'emails')
    } finally {
      carrier.maxAttempts = maxAttempts
    }

    expect(attempts).toEqual(['o-12'])
    expect(failures).toEqual(['o-12:smtp down'])
    expect(await driver.getFailedJobs()).toHaveLength(1)
  })

  it('removes a queued once listener when it has run, not when it was dispatched', async () => {
    const app = await bootWithQueue()

    const events = app.container.make('events')
    const handled: string[] = []
    events.once(OrderPlaced, (event) => { handled.push(event.orderId) }, { queue: 'emails' })

    await events.emit(new OrderPlaced('o-7'))
    // Still registered: nothing has run it yet.
    expect(events.listenerCount(OrderPlaced)).toBe(1)

    await drain(driver, 'emails')
    expect(handled).toEqual(['o-7'])
    expect(events.listenerCount(OrderPlaced)).toBe(0)

    await events.emit(new OrderPlaced('o-8'))
    await drain(driver, 'emails')
    expect(handled).toEqual(['o-7'])
  })

  it('runs both of two queued once listeners on one queue, though the first removes itself', async () => {
    const app = await bootWithQueue()

    const events = app.container.make('events')
    const handled: string[] = []
    events.once(OrderPlaced, () => { handled.push('first') }, { queue: 'emails' })
    events.once(OrderPlaced, () => { handled.push('second') }, { queue: 'emails' })

    await events.emit(new OrderPlaced('o-11'))
    expect(await driver.size('emails')).toBe(2)

    await drain(driver, 'emails')

    expect(handled).toEqual(['first', 'second'])
    expect(events.listenerCount(OrderPlaced)).toBe(0)
    expect(await driver.getFailedJobs()).toEqual([])
  })

  it('removes a queued once listener on the worker process that ran it', async () => {
    const worker = createEventManager()
    const handled: string[] = []
    worker.once(OrderPlaced, (event) => { handled.push(event.orderId) }, { queue: 'emails' })

    await worker.handleQueued('emails', 'OrderPlaced', { orderId: 'o-9' }, 0)

    expect(handled).toEqual(['o-9'])
    expect(worker.listenerCount(OrderPlaced)).toBe(0)
  })

  it('rebuilds an event a worker only registered the class for', async () => {
    const app = new Application({ providers: [EventServiceProvider] })
    await app.boot()
    setQueueDriver(driver)

    const emitter = app.container.make<EventManager>('events')
    emitter.setQueueDispatcher(createQueueEventDispatcher())
    emitter.registerEvent(OrderPlaced)
    emitter.on('OrderPlaced', () => {}, { queue: 'emails' })

    await emitter.emit(new OrderPlaced('o-10'))

    const seen: OrderPlaced[] = []
    const worker = createEventManager()
    worker.registerEvent(OrderPlaced)
    worker.on('OrderPlaced', (event) => { seen.push(event as OrderPlaced) }, { queue: 'emails' })
    app.container.instance('events', worker)

    await drain(driver, 'emails')

    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(OrderPlaced)
  })
})
