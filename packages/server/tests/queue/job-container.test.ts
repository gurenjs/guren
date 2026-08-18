import { describe, it, expect, beforeEach } from 'bun:test'
import { Application } from '../../src/http/Application'
import { Job, SyncDriver, createQueueManager, registerJob, clearJobRegistry } from '../../src/queue'

interface Mailer {
  send: (subject: string) => void
}

class ResolvingJob extends Job<{ subject: string }> {
  async handle(payload: { subject: string }): Promise<void> {
    this.make<Mailer>('mail').send(payload.subject)
  }
}

function useSyncDriver(): void {
  createQueueManager({
    default: 'sync',
    drivers: { sync: () => new SyncDriver() },
  }).driver()
}

describe('Job.make() against an Application container', () => {
  beforeEach(() => {
    clearJobRegistry()
    useSyncDriver()
    registerJob(ResolvingJob)
  })

  it('resolves bindings when a job runs on the sync driver', async () => {
    const app = new Application()
    const sent: string[] = []
    app.container.instance('mail', { send: (subject: string) => sent.push(subject) } satisfies Mailer)
    await app.boot()

    await ResolvingJob.dispatch({ subject: 'Welcome' })

    expect(sent).toEqual(['Welcome'])
  })

  it('resolves bindings before the application is booted', async () => {
    // `guren queue:work` imports the app entry and reads the queue driver
    // without calling boot(), so a job can run against a constructed-only app.
    // Moving the setContainer() call into boot() fails this test and not the
    // one above.
    const app = new Application()
    const sent: string[] = []
    app.container.instance('mail', { send: (subject: string) => sent.push(subject) } satisfies Mailer)

    await ResolvingJob.dispatch({ subject: 'Unbooted' })

    expect(sent).toEqual(['Unbooted'])
  })
})
