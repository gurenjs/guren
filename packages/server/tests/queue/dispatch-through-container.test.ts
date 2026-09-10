import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Application } from '../../src/http/Application'
import { createContainer, setContainer } from '../../src/container'
import { QueueServiceProvider } from '../../src/providers/QueueServiceProvider'
import { Job, MemoryDriver, getQueueDriver, setQueueDriver } from '../../src/queue'
import { mail, createMailManager } from '../../src/mail'

class ReportJob extends Job<{ id: number }> {
  static queue = 'reports'
  handle(): void {}
}

describe('Job.dispatch() with only the container wired', () => {
  let driver: MemoryDriver

  beforeEach(() => {
    driver = new MemoryDriver()
    // The global slot is what QueueManager.driver() would have filled; the
    // point here is that nothing ever called it.
    setQueueDriver(null as never)
  })

  afterEach(() => {
    setQueueDriver(null as never)
    setContainer(createContainer())
  })

  async function bootWithQueue(): Promise<Application> {
    const app = new Application({ providers: [QueueServiceProvider] })
    await app.boot()
    app.container.make('queue').registerDriver('memory', () => driver)
    return app
  }

  it('sends through the queue manager bound as "queue" without a prior manager.driver() call', async () => {
    await bootWithQueue()

    await ReportJob.dispatch({ id: 1 })

    expect(await driver.size('reports')).toBe(1)
  })

  it('lets Mail.queue() find the same driver', async () => {
    await bootWithQueue()
    const manager = createMailManager({ transports: { memory: { driver: 'memory' } }, default: 'memory' })

    await mail(manager).to('a@example.com').subject('Hi').text('Hello').queue('mail')

    expect(await driver.size('mail')).toBe(1)
  })

  it('keeps the global driver as the override', async () => {
    await bootWithQueue()
    const override = new MemoryDriver()
    setQueueDriver(override)

    await ReportJob.dispatch({ id: 2 })

    expect(await override.size('reports')).toBe(1)
    expect(await driver.size('reports')).toBe(0)
  })

  it('names the provider to register when neither the global nor the container has a driver', async () => {
    const app = new Application()
    await app.boot()

    expect(getQueueDriver()).toBeNull()
    await expect(ReportJob.dispatch({ id: 3 })).rejects.toThrow(
      'Queue driver not configured. Register a provider that binds a QueueManager as "queue"',
    )
  })
})
