import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Container } from '../../src/container/Container'
import { resetDefaultApplication } from '../../src/http/default-application'
import {
  DatabaseChannel,
  Notification,
  NotificationManager,
  clearNotificationRegistry,
  registerNotification,
  type DatabaseNotification,
  type Notifiable,
} from '../../src/notifications'
import { MemoryDriver, Worker, clearJobRegistry, clearQueueDriver, setQueueDriver } from '../../src/queue'

class QueuedNote extends Notification {
  static shouldQueue = true

  via(): string[] {
    return ['database']
  }

  toDatabase(): Record<string, unknown> {
    return { note: 'queued' }
  }
}

class User implements Notifiable {
  notifications: DatabaseNotification[] = []

  constructor(public id: number) {}

  routeNotificationFor(): string | null {
    return null
  }
}

describe('queued notifications resolved through the container (RFC 0023 §4)', () => {
  let driver: MemoryDriver

  beforeEach(() => {
    resetDefaultApplication()
    clearJobRegistry()
    clearNotificationRegistry()
    driver = new MemoryDriver()
    setQueueDriver(driver)
    registerNotification(QueuedNote)
  })

  afterEach(() => {
    clearQueueDriver()
    clearJobRegistry()
    clearNotificationRegistry()
    resetDefaultApplication()
  })

  it('sends through the manager bound in the worker\'s container, not the one that registered the job', async () => {
    const sender = new NotificationManager()
    const senderDb = new DatabaseChannel()
    sender.registerChannel('database', senderDb)
    sender.registerQueueJob()

    const own = new Container()
    const bound = new NotificationManager()
    const boundDb = new DatabaseChannel()
    bound.registerChannel('database', boundDb)
    own.instance('notifications', bound)

    await sender.send(new User(1), new QueuedNote())
    await new Worker(driver, { queues: ['notifications'], sleep: 0, stopWhenEmpty: true, container: own }).start()

    expect(boundDb.getStored()).toHaveLength(1)
    expect(senderDb.getStored()).toHaveLength(0)
  })

  it('falls back to the manager registerQueueJob() left when the container binds none', async () => {
    const sender = new NotificationManager()
    const senderDb = new DatabaseChannel()
    sender.registerChannel('database', senderDb)
    sender.registerQueueJob()

    await sender.send(new User(1), new QueuedNote())
    await new Worker(driver, { queues: ['notifications'], sleep: 0, stopWhenEmpty: true, container: new Container() }).start()

    expect(senderDb.getStored()).toHaveLength(1)
  })
})
