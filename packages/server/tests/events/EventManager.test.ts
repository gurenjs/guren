import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  Event,
  EventManager,
  createEventManager,
  Listener,
} from '../../src/events'
import { resetWarnOnce } from '../../src/support/warn-once'

class TestEvent extends Event {
  constructor(public readonly message: string) {
    super()
  }
}

class AnotherEvent extends Event {
  constructor(public readonly value: number) {
    super()
  }
}

describe('Event', () => {
  it('has a timestamp', () => {
    const event = new TestEvent('hello')
    expect(event.timestamp).toBeInstanceOf(Date)
  })

  it('lets a subclass pin its wire name, without its own subclasses inheriting the pin', () => {
    class Pinned extends Event {
      static override eventName = 'order.placed'
    }
    class Derived extends Pinned {}

    expect(Pinned.eventName).toBe('order.placed')
    expect(new Pinned().eventName).toBe('order.placed')
    expect(new Derived().eventName).toBe('Derived')
  })

  it('has an event name from class name', () => {
    expect(TestEvent.eventName).toBe('TestEvent')
    const event = new TestEvent('hello')
    expect(event.eventName).toBe('TestEvent')
  })
})

describe('EventManager', () => {
  let events: EventManager

  beforeEach(() => {
    events = new EventManager()
  })

  describe('on()', () => {
    it('registers a listener', () => {
      const listener = vi.fn()
      events.on(TestEvent, listener)
      expect(events.hasListeners(TestEvent)).toBe(true)
    })

    it('registers multiple listeners for the same event', () => {
      const listener1 = vi.fn()
      const listener2 = vi.fn()
      events.on(TestEvent, listener1)
      events.on(TestEvent, listener2)
      expect(events.listenerCount(TestEvent)).toBe(2)
    })

    it('registers listeners with string event names', () => {
      const listener = vi.fn()
      events.on('custom:event', listener)
      expect(events.hasListeners('custom:event')).toBe(true)
    })

    it('returns a subscription handle', () => {
      const listener = vi.fn()
      const subscription = events.on(TestEvent, listener)
      expect(subscription).toHaveProperty('unsubscribe')
    })
  })

  describe('emit()', () => {
    it('calls registered listeners', async () => {
      const listener = vi.fn()
      events.on(TestEvent, listener)
      await events.emit(new TestEvent('hello'))
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('passes the event to listeners', async () => {
      const listener = vi.fn()
      events.on(TestEvent, listener)
      const event = new TestEvent('hello world')
      await events.emit(event)
      expect(listener).toHaveBeenCalledWith(event)
    })

    it('calls multiple listeners in order', async () => {
      const calls: number[] = []
      events.on(TestEvent, () => { calls.push(1) })
      events.on(TestEvent, () => { calls.push(2) })
      events.on(TestEvent, () => { calls.push(3) })
      await events.emit(new TestEvent('test'))
      expect(calls).toEqual([1, 2, 3])
    })

    it('respects priority ordering (higher first)', async () => {
      const calls: number[] = []
      events.on(TestEvent, () => { calls.push(1) }, { priority: 0 })
      events.on(TestEvent, () => { calls.push(2) }, { priority: 10 })
      events.on(TestEvent, () => { calls.push(3) }, { priority: 5 })
      await events.emit(new TestEvent('test'))
      expect(calls).toEqual([2, 3, 1])
    })

    it('awaits async listeners', async () => {
      const calls: number[] = []
      events.on(TestEvent, async () => {
        await new Promise((r) => setTimeout(r, 10))
        calls.push(1)
      })
      events.on(TestEvent, () => { calls.push(2) })
      await events.emit(new TestEvent('test'))
      expect(calls).toEqual([1, 2])
    })

    it('does not fail if no listeners registered', async () => {
      await expect(events.emit(new TestEvent('test'))).resolves.toBeUndefined()
    })

    it('emits to string event names', async () => {
      const listener = vi.fn()
      events.on('custom:event', listener)

      class CustomEvent extends Event {
        static get eventName() { return 'custom:event' }
      }

      await events.emit(new CustomEvent())
      expect(listener).toHaveBeenCalled()
    })
  })

  describe('emitParallel()', () => {
    it('calls listeners in parallel', async () => {
      const startTime = Date.now()
      const calls: number[] = []

      events.on(TestEvent, async () => {
        await new Promise((r) => setTimeout(r, 50))
        calls.push(1)
      })
      events.on(TestEvent, async () => {
        await new Promise((r) => setTimeout(r, 50))
        calls.push(2)
      })

      await events.emitParallel(new TestEvent('test'))
      const duration = Date.now() - startTime

      expect(calls).toHaveLength(2)
      // Should complete in ~50ms, not ~100ms (parallel)
      expect(duration).toBeLessThan(100)
    })
  })

  describe('once()', () => {
    it('removes listener after first invocation', async () => {
      const listener = vi.fn()
      events.once(TestEvent, listener)

      await events.emit(new TestEvent('first'))
      await events.emit(new TestEvent('second'))

      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('still respects priority', async () => {
      const calls: number[] = []
      events.on(TestEvent, () => { calls.push(1) }, { priority: 0 })
      events.once(TestEvent, () => { calls.push(2) }, { priority: 10 })

      await events.emit(new TestEvent('test'))
      expect(calls).toEqual([2, 1])
    })
  })

  describe('off()', () => {
    it('removes a specific listener', () => {
      const listener1 = vi.fn()
      const listener2 = vi.fn()
      events.on(TestEvent, listener1)
      events.on(TestEvent, listener2)

      events.off(TestEvent, listener1)

      expect(events.listenerCount(TestEvent)).toBe(1)
    })

    it('removes all listeners when no listener specified', () => {
      events.on(TestEvent, vi.fn())
      events.on(TestEvent, vi.fn())

      events.off(TestEvent)

      expect(events.hasListeners(TestEvent)).toBe(false)
    })

    it('does nothing if event not registered', () => {
      events.off(TestEvent, vi.fn())
    })

    it('works with string event names', () => {
      const listener = vi.fn()
      events.on('custom:event', listener)
      events.off('custom:event', listener)
      expect(events.hasListeners('custom:event')).toBe(false)
    })
  })

  describe('subscription.unsubscribe()', () => {
    it('removes the listener', async () => {
      const listener = vi.fn()
      const sub = events.on(TestEvent, listener)

      sub.unsubscribe()
      await events.emit(new TestEvent('test'))

      expect(listener).not.toHaveBeenCalled()
    })
  })

  describe('hasListeners()', () => {
    it('returns true when listeners exist', () => {
      events.on(TestEvent, vi.fn())
      expect(events.hasListeners(TestEvent)).toBe(true)
    })

    it('returns false when no listeners exist', () => {
      expect(events.hasListeners(TestEvent)).toBe(false)
    })

    it('returns false after all listeners removed', async () => {
      events.once(TestEvent, vi.fn())
      await events.emit(new TestEvent('test'))
      expect(events.hasListeners(TestEvent)).toBe(false)
    })
  })

  describe('getListeners()', () => {
    it('returns all listeners for an event', () => {
      const listener1 = vi.fn()
      const listener2 = vi.fn()
      events.on(TestEvent, listener1)
      events.on(TestEvent, listener2)

      const listeners = events.getListeners(TestEvent)

      expect(listeners).toContain(listener1)
      expect(listeners).toContain(listener2)
    })

    it('returns empty array for unregistered event', () => {
      expect(events.getListeners(TestEvent)).toEqual([])
    })
  })

  describe('listenerCount()', () => {
    it('returns the number of listeners', () => {
      events.on(TestEvent, vi.fn())
      events.on(TestEvent, vi.fn())
      events.on(AnotherEvent, vi.fn())

      expect(events.listenerCount(TestEvent)).toBe(2)
      expect(events.listenerCount(AnotherEvent)).toBe(1)
    })

    it('returns 0 for unregistered event', () => {
      expect(events.listenerCount(TestEvent)).toBe(0)
    })
  })

  describe('eventNames()', () => {
    it('returns all registered event names', () => {
      events.on(TestEvent, vi.fn())
      events.on(AnotherEvent, vi.fn())
      events.on('custom:event', vi.fn())

      const names = events.eventNames()

      expect(names).toContain('TestEvent')
      expect(names).toContain('AnotherEvent')
      expect(names).toContain('custom:event')
    })

    it('returns empty array when no events registered', () => {
      expect(events.eventNames()).toEqual([])
    })
  })

  describe('removeAllListeners()', () => {
    it('removes all listeners for all events', () => {
      events.on(TestEvent, vi.fn())
      events.on(AnotherEvent, vi.fn())

      events.removeAllListeners()

      expect(events.eventNames()).toEqual([])
    })
  })

  describe('queue integration', () => {
    beforeEach(() => {
      resetWarnOnce()
    })

    it('dispatches to queue when dispatcher is set', async () => {
      const dispatcher = vi.fn()
      events.setQueueDispatcher(dispatcher)

      events.on(TestEvent, vi.fn(), { queue: 'emails' })
      const event = new TestEvent('test')
      await events.emit(event)

      expect(dispatcher).toHaveBeenCalledWith('emails', 'TestEvent', event, 0)
    })

    it('calls listener directly when no queue specified', async () => {
      const dispatcher = vi.fn()
      const listener = vi.fn()
      events.setQueueDispatcher(dispatcher)

      events.on(TestEvent, listener)
      await events.emit(new TestEvent('test'))

      expect(dispatcher).not.toHaveBeenCalled()
      expect(listener).toHaveBeenCalled()
    })

    it('warns once and runs the listener inline when no dispatcher is set', async () => {
      const listener = vi.fn()
      const warnings: string[] = []
      const warn = console.warn
      console.warn = (message: string) => warnings.push(message)
      events.on(TestEvent, listener, { queue: 'emails' })

      try {
        await events.emit(new TestEvent('test'))
        await events.emit(new TestEvent('test'))
      } finally {
        console.warn = warn
      }

      expect(listener).toHaveBeenCalledTimes(2)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('setQueueDispatcher(createQueueEventDispatcher())')
    })

    it('runs the listener inline when the dispatcher reports no queue is reachable', async () => {
      const dispatcher = vi.fn()
      const listener = vi.fn()
      const warn = console.warn
      console.warn = () => {}
      events.setQueueDispatcher(dispatcher, () => false)
      events.on(TestEvent, listener, { queue: 'emails' })

      try {
        await events.emit(new TestEvent('test'))
      } finally {
        console.warn = warn
      }

      expect(dispatcher).not.toHaveBeenCalled()
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('sends one message per queued listener, indexed within its own queue', async () => {
      const dispatcher = vi.fn()
      events.setQueueDispatcher(dispatcher)
      const inline = vi.fn()

      events.on(TestEvent, vi.fn(), { queue: 'emails' })
      events.on(TestEvent, vi.fn(), { queue: 'emails' })
      events.on(TestEvent, vi.fn(), { queue: 'audit' })
      events.on(TestEvent, inline)
      const event = new TestEvent('test')

      await events.emit(event)
      expect(dispatcher.mock.calls.map((call) => [call[0], call[3]])).toEqual([
        ['emails', 0],
        ['emails', 1],
        ['audit', 0],
      ])
      // Numbered per queue at registration, so a removal does not renumber the rest.
      expect(inline).toHaveBeenCalledTimes(1)

      dispatcher.mockClear()
      await events.emitParallel(event)
      expect(dispatcher.mock.calls.map((call) => [call[0], call[3]]).sort()).toEqual([
        ['audit', 0],
        ['emails', 0],
        ['emails', 1],
      ])
    })

    it('handleQueued() runs the listener the message names, with the event rebuilt as an instance', async () => {
      events.setQueueDispatcher(async () => {})
      const seen: TestEvent[] = []
      const second = vi.fn()
      const otherQueue = vi.fn()
      const inline = vi.fn()
      events.on(TestEvent, (event) => { seen.push(event) }, { queue: 'emails' })
      events.on(TestEvent, second, { queue: 'emails' })
      events.on(TestEvent, otherQueue, { queue: 'audit' })
      events.on(TestEvent, inline)

      // The shape a JSON-serializing driver hands back: own fields, Date as ISO.
      await events.handleQueued('emails', 'TestEvent', { message: 'hello', timestamp: '2026-01-01T00:00:00.000Z' }, 0)

      expect(seen).toHaveLength(1)
      expect(seen[0]).toBeInstanceOf(TestEvent)
      expect(seen[0].message).toBe('hello')
      expect(seen[0].eventName).toBe('TestEvent')
      expect(seen[0].timestamp).toEqual(new Date('2026-01-01T00:00:00.000Z'))
      expect(second).not.toHaveBeenCalled()
      expect(otherQueue).not.toHaveBeenCalled()
      expect(inline).not.toHaveBeenCalled()
    })

    it('handleQueued() refuses a listener number this process did not register', async () => {
      events.on(TestEvent, vi.fn(), { queue: 'emails' })

      await expect(events.handleQueued('emails', 'TestEvent', { message: 'x' }, 3)).rejects.toThrow(
        'no listener registered under that number (1 on that queue)',
      )
    })

    it('does not renumber re-registered listeners after removeAllListeners()', async () => {
      const dispatcher = vi.fn()
      events.setQueueDispatcher(dispatcher)
      const late = vi.fn()

      events.on(TestEvent, vi.fn(), { queue: 'emails' })
      events.removeAllListeners()
      events.on(TestEvent, late, { queue: 'emails' })
      await events.emit(new TestEvent('x'))

      expect(dispatcher.mock.calls[0][3]).toBe(1)
      // A message minted before the reset names 0, which nothing answers to now.
      await expect(events.handleQueued('emails', 'TestEvent', { message: 'x' }, 0)).rejects.toThrow(
        'no listener registered under that number',
      )
      expect(late).not.toHaveBeenCalled()
    })

    it('handleQueued() refuses an event name no class is registered for', async () => {
      events.on('LooselyNamed', vi.fn(), { queue: 'emails' })

      await expect(events.handleQueued('emails', 'LooselyNamed', {}, 0)).rejects.toThrow(
        'No event class is registered for "LooselyNamed"',
      )
    })
  })

  describe('listen()', () => {
    it('registers a Listener class under its statics', async () => {
      const order: string[] = []
      const failures: Error[] = []

      class First extends Listener<TestEvent> {
        static override event = TestEvent
        static override priority = 10
        handle(event: TestEvent): void {
          order.push(`first:${event.message}`)
        }
      }
      class Second extends Listener<TestEvent> {
        static override event = TestEvent
        handle(event: TestEvent): void {
          order.push(`second:${event.message}`)
        }
        override shouldHandle(event: TestEvent): boolean {
          return event.message !== 'skip'
        }
      }
      class Failing extends Listener<TestEvent> {
        static override event = TestEvent
        static override priority = -1
        handle(): void {
          throw new Error('boom')
        }
        override failed(_event: TestEvent, error: Error): void {
          failures.push(error)
        }
      }

      events.listen(Second)
      events.listen(First)
      events.listen(Failing)

      // Failing rethrows after failed(), so emit() rejects once it is reached.
      await expect(events.emit(new TestEvent('go'))).rejects.toThrow('boom')
      await expect(events.emit(new TestEvent('skip'))).rejects.toThrow('boom')

      expect(order).toEqual(['first:go', 'second:go', 'first:skip'])
      expect(failures.map((error) => error.message)).toEqual(['boom', 'boom'])
    })

    it('propagates a handle() failure when the class defines no failed()', async () => {
      class Throwing extends Listener<TestEvent> {
        static override event = TestEvent
        handle(): void {
          throw new Error('unhandled')
        }
      }
      events.listen(Throwing)

      await expect(events.emit(new TestEvent('x'))).rejects.toThrow('unhandled')
    })

    it('routes a shouldQueue listener through the queue dispatcher', async () => {
      const dispatcher = vi.fn()
      events.setQueueDispatcher(dispatcher)
      const handled = vi.fn()

      class Queued extends Listener<TestEvent> {
        static override event = TestEvent
        static override shouldQueue = true
        static override queue = 'emails'
        handle(): void {
          handled()
        }
      }
      events.listen(Queued)

      const event = new TestEvent('x')
      await events.emit(event)

      expect(dispatcher).toHaveBeenCalledWith('emails', 'TestEvent', event, 0)
      expect(handled).not.toHaveBeenCalled()

      await events.handleQueued('emails', 'TestEvent', { message: 'x' }, 0)
      expect(handled).toHaveBeenCalledTimes(1)
    })
  })
})

describe('Listener', () => {
  it('has static properties', () => {
    class TestListener extends Listener<TestEvent> {
      static event = TestEvent
      static shouldQueue = true
      static queue = 'custom'
      static priority = 10

      handle(_event: TestEvent) {
      }
    }

    expect(TestListener.event).toBe(TestEvent)
    expect(TestListener.shouldQueue).toBe(true)
    expect(TestListener.queue).toBe('custom')
    expect(TestListener.priority).toBe(10)
  })

  it('has default static property values', () => {
    class TestListener extends Listener<TestEvent> {
      static event = TestEvent

      handle(_event: TestEvent) {
      }
    }

    expect(TestListener.shouldQueue).toBe(false)
    expect(TestListener.queue).toBe('default')
    expect(TestListener.priority).toBe(0)
  })
})

describe('createEventManager()', () => {
  it('creates a new EventManager instance', () => {
    const events = createEventManager()
    expect(events).toBeInstanceOf(EventManager)
  })
})
