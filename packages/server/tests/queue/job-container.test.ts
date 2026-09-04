import { describe, it, expect, beforeEach } from 'bun:test'
import { Application } from '../../src/http/Application'
import { resolve } from '../../src/container'
import {
  Job,
  MemoryDriver,
  SyncDriver,
  Worker,
  createQueueManager,
  registerJob,
  clearJobRegistry,
} from '../../src/queue'

interface Mailer {
  send: (subject: string) => void
}

class ResolvingJob extends Job<{ subject: string }> {
  async handle(payload: { subject: string }): Promise<void> {
    this.make<Mailer>('mail').send(payload.subject)
  }
}

function appWithMailer(): { app: Application; sent: string[] } {
  const app = new Application()
  const sent: string[] = []
  app.container.instance('mail', { send: (subject: string) => sent.push(subject) } satisfies Mailer)
  return { app, sent }
}

describe('the container an Application publishes', () => {
  beforeEach(() => {
    clearJobRegistry()
    registerJob(ResolvingJob)
  })

  it('lets a job resolve bindings on the sync driver', async () => {
    createQueueManager({ default: 'sync', drivers: { sync: () => new SyncDriver() } }).driver()
    const { app, sent } = appWithMailer()
    await app.boot()

    await ResolvingJob.dispatch({ subject: 'Welcome' })

    expect(sent).toEqual(['Welcome'])
  })

  it('lets a job resolve bindings before the application is booted', async () => {
    // `guren queue:work` bootstraps only far enough to read the queue driver.
    // Moving the setContainer() call into boot() fails this test, not the one above.
    createQueueManager({ default: 'sync', drivers: { sync: () => new SyncDriver() } }).driver()
    const { sent } = appWithMailer()

    await ResolvingJob.dispatch({ subject: 'Unbooted' })

    expect(sent).toEqual(['Unbooted'])
  })

  it('lets a job resolve bindings when a worker drains the queue', async () => {
    // The shape `queue:work` actually runs: dispatch only enqueues, and the job
    // is constructed and handled later by the Worker.
    const driver = new MemoryDriver()
    createQueueManager({ default: 'memory', drivers: { memory: () => driver } }).driver()
    const { app, sent } = appWithMailer()
    await app.boot()

    await ResolvingJob.dispatch({ subject: 'Deferred' })
    expect(sent).toEqual([])

    await new Worker(driver, { queues: ['default'], sleep: 0, stopWhenEmpty: true }).start()

    expect(sent).toEqual(['Deferred'])
  })

  it('backs the exported resolve() helper', () => {
    const { app } = appWithMailer()
    app.container.instance('probe', { value: 42 })

    expect(resolve<{ value: number }>('probe')).toEqual({ value: 42 })
  })

  it('keeps the previous container when an application fails to construct', () => {
    const { app } = appWithMailer()
    app.container.instance('probe', { value: 'first' })

    class ExplodingProvider {
      constructor() {
        throw new Error('provider blew up')
      }
    }

    expect(
      () => new Application({ providers: [ExplodingProvider as never] }),
    ).toThrow('provider blew up')
    expect(resolve<{ value: string }>('probe')).toEqual({ value: 'first' })
  })
})
