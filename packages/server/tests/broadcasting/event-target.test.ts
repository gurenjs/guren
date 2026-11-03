import { describe, expect, it } from 'bun:test'
import { BroadcastManager, broadcastChannelsOf, broadcastNameOf, type BroadcastEvent } from '../../src/broadcasting'
import { Event } from '../../src/events/Event'

class OrderShipped extends Event {
  constructor(readonly orderId: number) {
    super()
  }

  broadcastOn(): string[] {
    return [`private-orders.${this.orderId}`, 'shipments']
  }

  broadcastWith(): Record<string, unknown> {
    return { orderId: this.orderId }
  }
}

class PinnedShipped extends OrderShipped {
  static override eventName = 'order.shipped'
}

describe('broadcastNameOf()', () => {
  it('prefers broadcastAs(), then the pinned eventName, then the class name', () => {
    const named = Object.assign(new OrderShipped(1), { broadcastAs: () => 'shipped' })

    expect(broadcastNameOf(named)).toBe('shipped')
    expect(broadcastNameOf(new PinnedShipped(1))).toBe('order.shipped')
    expect(broadcastNameOf(new OrderShipped(1))).toBe('OrderShipped')
  })

  it('reads the class name of an event that does not extend Event', () => {
    class Plain {
      broadcastOn(): string[] {
        return ['a']
      }
    }

    expect(broadcastNameOf(new Plain())).toBe('Plain')
  })

  it('refuses an object literal with no broadcastAs(), whose name would be "Object"', () => {
    expect(() => broadcastNameOf({ broadcastOn: () => ['a'] })).toThrow('needs a name')
  })
})

describe('broadcastChannelsOf()', () => {
  it('returns broadcastOn() verbatim, prefixes included', () => {
    expect(broadcastChannelsOf(new OrderShipped(7))).toEqual(['private-orders.7', 'shipments'])
  })

  it('refuses a broadcastOn() that does not return channel names', () => {
    const broken = { broadcastOn: () => 'orders' as unknown as string[], broadcastAs: () => 'x' }

    expect(() => broadcastChannelsOf(broken)).toThrow('must return an array of channel names')
  })
})

describe('BroadcastManager.broadcastEvent()', () => {
  it('publishes broadcastWith() under the name live() subscribes to, on every channel', async () => {
    const manager = new BroadcastManager()
    const received: BroadcastEvent[] = []
    manager.driver().subscribe('private-orders.3', (event) => received.push(event))
    manager.driver().subscribe('shipments', (event) => received.push(event))

    await manager.broadcastEvent(new PinnedShipped(3))

    expect(received.map(({ channel, event, data }) => ({ channel, event, data }))).toEqual([
      { channel: 'private-orders.3', event: 'order.shipped', data: { orderId: 3 } },
      { channel: 'shipments', event: 'order.shipped', data: { orderId: 3 } },
    ])
  })

  it('publishes an empty payload for an event with no broadcastWith()', async () => {
    const manager = new BroadcastManager()
    const received: unknown[] = []
    manager.driver().subscribe('a', (event) => received.push(event.data))

    await manager.broadcastEvent({ broadcastOn: () => ['a'], broadcastAs: () => 'Ping' })

    expect(received).toEqual([{}])
  })
})
