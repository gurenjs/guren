import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Container } from '../../src/container/Container'
import { Application } from '../../src/http/Application'
import { resetDefaultApplication } from '../../src/http/default-application'
import { MemoryTransport, createMailManager, mail, setMailManager, type MailManager } from '../../src/mail'
import { MemoryDriver, Worker, clearQueueDriver, createQueueManager, setQueueDriver } from '../../src/queue'
import { clearGlobalManager } from '../support/globals'

function memoryMailer(container?: Container): { manager: MailManager; transport: MemoryTransport } {
  const manager = createMailManager({ default: 'memory', transports: { memory: { driver: 'memory' } } }, container)
  return { manager, transport: manager.transport('memory') as MemoryTransport }
}

describe('queued mail resolved through the container (RFC 0023 §4)', () => {
  beforeEach(() => {
    resetDefaultApplication()
    clearQueueDriver()
    clearGlobalManager(setMailManager)
  })

  afterEach(() => {
    resetDefaultApplication()
    clearQueueDriver()
    clearGlobalManager(setMailManager)
  })

  it('sends through the mail manager bound in the worker\'s container, not the global one', async () => {
    const driver = new MemoryDriver()
    setQueueDriver(driver)
    const ambient = memoryMailer()
    setMailManager(ambient.manager)
    const own = new Container()
    const bound = memoryMailer(own)
    own.instance('mail', bound.manager)

    await mail(ambient.manager).to('a@example.com').subject('Hi').text('Body').queue()
    await new Worker(driver, { queues: ['default'], sleep: 0, stopWhenEmpty: true, container: own }).start()

    expect(bound.transport.getMessages()).toHaveLength(1)
    expect(ambient.transport.getMessages()).toHaveLength(0)
  })

  it('dispatches through the queue bound beside the mail manager, not the default application\'s', async () => {
    const ambientDriver = new MemoryDriver()
    const ambient = new Application()
    ambient.container.instance('queue', createQueueManager({ default: 'memory', drivers: { memory: () => ambientDriver } }))

    const own = new Container()
    const ownDriver = new MemoryDriver()
    own.instance('queue', createQueueManager({ default: 'memory', drivers: { memory: () => ownDriver } }))
    const { manager } = memoryMailer(own)

    await mail(manager).to('a@example.com').subject('Hi').text('Body').queue('emails')

    expect(await ownDriver.size('emails')).toBe(1)
    expect(await ambientDriver.size('emails')).toBe(0)
  })

  it('lets a setQueueDriver() pin override the bound queue, as it does for Job.dispatch()', async () => {
    const own = new Container()
    const ownDriver = new MemoryDriver()
    own.instance('queue', createQueueManager({ default: 'memory', drivers: { memory: () => ownDriver } }))
    const { manager } = memoryMailer(own)
    const pinned = new MemoryDriver()
    setQueueDriver(pinned)

    await mail(manager).to('a@example.com').subject('Hi').text('Body').queue()

    expect(await pinned.size('default')).toBe(1)
    expect(await ownDriver.size('default')).toBe(0)
  })

  it('falls back to the default application\'s queue for a manager bound with no container', async () => {
    const ambientDriver = new MemoryDriver()
    const ambient = new Application()
    ambient.container.instance('queue', createQueueManager({ default: 'memory', drivers: { memory: () => ambientDriver } }))
    const { manager } = memoryMailer()

    await mail(manager).to('a@example.com').subject('Hi').text('Body').queue()

    expect(await ambientDriver.size('default')).toBe(1)
  })
})
