import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Container } from '../../src/container/Container'
import { Application } from '../../src/http/Application'
import { resetDefaultApplication } from '../../src/http/default-application'
import {
  Job,
  MemoryDriver,
  Worker,
  clearJobRegistry,
  processJob,
  registerJob,
  type QueuedJob,
} from '../../src/queue'

interface Mailer {
  send: (subject: string) => void
}

const resolved: string[] = []

class ResolvingJob extends Job<{ subject: string }> {
  async handle(payload: { subject: string }): Promise<void> {
    this.make<Mailer>('mail').send(payload.subject)
  }
}

class FailingJob extends Job<{ subject: string }> {
  static override maxAttempts = 1

  async handle(): Promise<void> {
    throw new Error('no')
  }

  async failed(payload: { subject: string }): Promise<void> {
    this.make<Mailer>('mail').send(`failed:${payload.subject}`)
  }
}

function mailerInto(container: Container, tag: string): void {
  container.instance('mail', { send: (subject: string) => resolved.push(`${tag}:${subject}`) } satisfies Mailer)
}

function queued(name: string, subject: string): QueuedJob {
  return {
    id: subject,
    name,
    payload: { subject },
    queue: 'default',
    attempts: 0,
    maxAttempts: 1,
    availableAt: new Date(0),
    createdAt: new Date(0),
    reservedAt: null,
  }
}

describe('Worker { container }', () => {
  beforeEach(() => {
    resolved.length = 0
    clearJobRegistry()
    registerJob(ResolvingJob)
    registerJob(FailingJob)
  })

  afterEach(() => {
    resetDefaultApplication()
  })

  it('hands each job the container it was started with, not the default application', async () => {
    const ambient = new Application()
    mailerInto(ambient.container, 'ambient')
    const own = new Container()
    mailerInto(own, 'own')
    const driver = new MemoryDriver()
    await driver.push(queued('ResolvingJob', 'Welcome'))

    await new Worker(driver, { queues: ['default'], sleep: 0, stopWhenEmpty: true, container: own }).start()

    expect(resolved).toEqual(['own:Welcome'])
  })

  it('falls back to the default application without the option', async () => {
    const ambient = new Application()
    mailerInto(ambient.container, 'ambient')
    const driver = new MemoryDriver()
    await driver.push(queued('ResolvingJob', 'Welcome'))

    await new Worker(driver, { queues: ['default'], sleep: 0, stopWhenEmpty: true }).start()

    expect(resolved).toEqual(['ambient:Welcome'])
  })

  it('gives the failed() handler the same container', async () => {
    const own = new Container()
    mailerInto(own, 'own')
    const driver = new MemoryDriver()
    await driver.push(queued('FailingJob', 'Broken'))
    const silence = console.error
    console.error = () => {}

    try {
      await new Worker(driver, { queues: ['default'], sleep: 0, stopWhenEmpty: true, container: own }).start()
    } finally {
      console.error = silence
    }

    expect(resolved).toEqual(['own:failed:Broken'])
  })

  it('is accepted by processJob()', async () => {
    const own = new Container()
    mailerInto(own, 'own')
    const driver = new MemoryDriver()
    await driver.push(queued('ResolvingJob', 'One'))

    expect(await processJob(driver, 'default', { container: own })).toBe(true)
    expect(resolved).toEqual(['own:One'])
  })

  it('backs Job.setContainer() on a hand-constructed job', async () => {
    const own = new Container()
    mailerInto(own, 'own')
    const job = new ResolvingJob()
    job.setContainer(own)

    await job.handle({ subject: 'Direct' })

    expect(resolved).toEqual(['own:Direct'])
  })
})
