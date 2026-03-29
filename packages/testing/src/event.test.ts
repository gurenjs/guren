import { describe, expect, it } from 'vitest'
import { Event } from '@guren/server'
import { FakeEvent, FakeEventManager } from './event'

class TestEvent extends Event {
  static override eventName = 'TestEvent'

  constructor(public message: string) {
    super()
  }
}

describe('FakeEventManager', () => {
  it('records emitted events', async () => {
    const manager = new FakeEventManager()
    const event = new TestEvent('hello')

    await manager.emit(event)

    const recorded = manager.getEventsOf(TestEvent)
    expect(recorded).toHaveLength(1)
    expect(recorded[0].event).toBe(event)
  })

  it('manages listeners by event name', () => {
    const manager = new FakeEventManager()
    const listener = () => {}

    manager.on(TestEvent, listener)
    expect(manager.hasListeners(TestEvent)).toBe(true)
    expect(manager.listenerCount(TestEvent)).toBe(1)

    manager.off(TestEvent, listener)
    expect(manager.listenerCount(TestEvent)).toBe(0)
  })
})

describe('FakeEvent', () => {
  it('asserts dispatched events', () => {
    const fake = new FakeEvent()
    const event = new TestEvent('ping')

    fake.record(event)
    expect(() => fake.assertDispatched(TestEvent)).not.toThrow()
    expect(() => fake.assertDispatched(TestEvent, (e) => e.message === 'ping')).not.toThrow()
  })

  it('throws when expected event is missing', () => {
    const fake = new FakeEvent()
    expect(() => fake.assertDispatched(TestEvent)).toThrow('Expected event [TestEvent] to be dispatched')
  })
})
