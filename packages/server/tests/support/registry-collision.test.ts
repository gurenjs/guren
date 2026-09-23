import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Event, Listener, createEventManager } from '../../src/events'
import {
  DatabaseChannel,
  Notification,
  NotificationManager,
  clearNotificationRegistry,
  getNotification,
  registerNotification,
  type Notifiable,
} from '../../src/notifications'
import { Job, MemoryDriver, clearJobRegistry, getJob, registerJob } from '../../src/queue'
import { resetWarnOnce } from '../../src/support/warn-once'
import { bootWithMemoryQueue, resetQueueState } from '../queue/helpers'
import { captureWarnings } from './warnings'

// Each call is a distinct class with the same name, as two modules declaring `SendMail` would be.
function sendMailJob() {
  return class SendMail extends Job {
    async handle(): Promise<void> {}
  }
}

function orderPlacedEvent() {
  return class OrderPlaced extends Event {}
}

function welcomeNotification() {
  return class WelcomeNotification extends Notification {
    static shouldQueue = true

    via(): string[] {
      return ['database']
    }

    toDatabase(): Record<string, unknown> {
      return {}
    }
  }
}

const recipient: Notifiable = { routeNotificationFor: () => null }

beforeEach(() => {
  resetWarnOnce()
  clearJobRegistry()
  clearNotificationRegistry()
})

afterEach(() => {
  resetQueueState()
  clearJobRegistry()
  clearNotificationRegistry()
  resetWarnOnce()
})

describe('job registry', () => {
  test('registering the same class again is silent', async () => {
    const SendMail = sendMailJob()

    const warnings = await captureWarnings(() => {
      registerJob(SendMail)
      registerJob(SendMail)
    })

    expect(warnings).toEqual([])
    expect(getJob('SendMail')).toBe(SendMail)
  })

  test('a different class under a taken name warns once, naming both, and still replaces it', async () => {
    const First = sendMailJob()
    const Second = sendMailJob()

    const warnings = await captureWarnings(() => {
      registerJob(First)
      registerJob(Second)
      registerJob(First)
      registerJob(Second)
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Two different job classes are registered as "SendMail" (both named SendMail)')
    expect(warnings[0]).toContain('static jobName')
    expect(getJob('SendMail')).toBe(Second)
  })

  test('a pinned jobName colliding with another class name warns with both class names', async () => {
    const SendMail = sendMailJob()
    class SendWelcomeMail extends Job {
      static jobName = 'SendMail'
      async handle(): Promise<void> {}
    }

    const warnings = await captureWarnings(() => {
      registerJob(SendMail)
      registerJob(SendWelcomeMail)
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('registered as "SendMail" (SendMail and SendWelcomeMail)')
  })
})

describe('event classes', () => {
  test('the same class through on() and registerEvent(), beside a string listener, is silent', async () => {
    const OrderPlaced = orderPlacedEvent()
    const events = createEventManager()

    const warnings = await captureWarnings(() => {
      events.on(OrderPlaced, () => {})
      events.on(OrderPlaced, () => {})
      events.registerEvent(OrderPlaced)
      events.on('OrderPlaced', () => {})
    })

    expect(warnings).toEqual([])
  })

  test('a different class under a taken name warns once and says the listeners are shared', async () => {
    const First = orderPlacedEvent()
    const Second = orderPlacedEvent()
    const events = createEventManager()
    const handled: string[] = []

    const warnings = await captureWarnings(() => {
      events.on(First, () => { handled.push('first') })
      events.on(Second, () => { handled.push('second') })
      events.registerEvent(First)
    })
    await events.emit(new First())

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Two different event classes are registered as "OrderPlaced" (both named OrderPlaced)')
    expect(warnings[0]).toContain('static eventName')
    expect(handled).toEqual(['first', 'second'])
  })

  test('a pinned eventName colliding with another class name warns with both class names', async () => {
    const OrderPlaced = orderPlacedEvent()
    class OrderShipped extends Event {
      static override eventName = 'OrderPlaced'
    }
    const events = createEventManager()

    const warnings = await captureWarnings(() => {
      events.registerEvent(OrderPlaced)
      events.on(OrderShipped, () => {})
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('registered as "OrderPlaced" (OrderPlaced and OrderShipped)')
  })

  test('a Listener class for a different same-named event warns through listen()', async () => {
    const First = orderPlacedEvent()
    const Second = orderPlacedEvent()
    class NotifyWarehouse extends Listener<InstanceType<typeof Second>> {
      static override event = Second
      handle(): void {}
    }
    const events = createEventManager()

    const warnings = await captureWarnings(() => {
      events.on(First, () => {})
      events.listen(NotifyWarehouse)
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Two different event classes are registered as "OrderPlaced" (both named OrderPlaced)')
  })

  test('two managers keep their own classes', async () => {
    const warnings = await captureWarnings(() => {
      createEventManager().registerEvent(orderPlacedEvent())
      createEventManager().registerEvent(orderPlacedEvent())
    })

    expect(warnings).toEqual([])
  })
})

describe('notification registry', () => {
  test('the same class again, and under a second type, is silent', async () => {
    const WelcomeNotification = welcomeNotification()

    const warnings = await captureWarnings(() => {
      registerNotification(WelcomeNotification)
      registerNotification(WelcomeNotification)
      registerNotification(WelcomeNotification, 'LegacyWelcome')
    })

    expect(warnings).toEqual([])
    expect(getNotification('LegacyWelcome')).toBe(WelcomeNotification)
  })

  test('a different class under a taken type warns once, naming both, and still replaces it', async () => {
    const First = welcomeNotification()
    const Second = welcomeNotification()

    const warnings = await captureWarnings(() => {
      registerNotification(First)
      registerNotification(Second)
      registerNotification(First)
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(
      'Two different notification classes are registered as "WelcomeNotification" (both named WelcomeNotification)',
    )
    expect(warnings[0]).toContain('type getter')
    expect(getNotification('WelcomeNotification')).toBe(First)
  })

  test('a pinned type colliding with another class name warns with both class names', async () => {
    const WelcomeNotification = welcomeNotification()
    class InvoicePaid extends Notification {
      override get type(): string {
        return 'WelcomeNotification'
      }

      via(): string[] {
        return []
      }
    }

    const warnings = await captureWarnings(() => {
      registerNotification(WelcomeNotification)
      registerNotification(InvoicePaid)
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('registered as "WelcomeNotification" (WelcomeNotification and InvoicePaid)')
  })

  test('queueing registers the class, so two same-named classes sent through one manager warn', async () => {
    await bootWithMemoryQueue(new MemoryDriver())
    const manager = new NotificationManager()
    manager.registerChannel('database', new DatabaseChannel())
    const First = welcomeNotification()
    const Second = welcomeNotification()

    const warnings = await captureWarnings(async () => {
      await manager.send(recipient, new First())
      await manager.send(recipient, new Second())
    })

    expect(warnings.filter((warning) => warning.includes('Two different notification classes'))).toHaveLength(1)
  })
})
