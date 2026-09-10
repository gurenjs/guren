import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Application } from '../../src/http/Application'
import { createContainer, setContainer } from '../../src/container'
import { EventServiceProvider } from '../../src/providers/EventServiceProvider'
import { QueueServiceProvider } from '../../src/providers/QueueServiceProvider'
import { Event } from '../../src/events'
import { MemoryDriver, Worker, setQueueDriver } from '../../src/queue'

class OrderPlaced extends Event {
  constructor(public readonly orderId: string) {
    super()
  }
}

describe('queued listeners through the providers', () => {
  let driver: MemoryDriver

  beforeEach(() => {
    driver = new MemoryDriver()
    setQueueDriver(null as never)
  })

  afterEach(() => {
    setQueueDriver(null as never)
    setContainer(createContainer())
  })

  it('pushes the emit onto the queue and runs the listener when a worker drains it', async () => {
    const app = new Application({ providers: [EventServiceProvider, QueueServiceProvider] })
    await app.boot()
    app.container.make('queue').registerDriver('memory', () => driver)

    const events = app.container.make('events')
    const handled: OrderPlaced[] = []
    const inline: string[] = []
    events.on(OrderPlaced, (event) => { handled.push(event) }, { queue: 'emails' })
    events.on(OrderPlaced, (event) => { inline.push(event.orderId) })

    await events.emit(new OrderPlaced('o-1'))

    expect(inline).toEqual(['o-1'])
    expect(handled).toEqual([])
    expect(await driver.size('emails')).toBe(1)

    await new Worker(driver, { queues: ['emails'], sleep: 0, stopWhenEmpty: true }).start()

    expect(handled).toHaveLength(1)
    expect(handled[0]).toBeInstanceOf(OrderPlaced)
    expect(handled[0].orderId).toBe('o-1')
    expect(await driver.size('emails')).toBe(0)
  })

  it('refuses a queued listener when the app binds no queue', async () => {
    const app = new Application({ providers: [EventServiceProvider] })
    await app.boot()

    const events = app.container.make('events')
    expect(events.hasQueueDispatcher()).toBe(false)
    events.on(OrderPlaced, () => {}, { queue: 'emails' })

    await expect(events.emit(new OrderPlaced('o-2'))).rejects.toThrow('has no queue dispatcher')
  })
})
