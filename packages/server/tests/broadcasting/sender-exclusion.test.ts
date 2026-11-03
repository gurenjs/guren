import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createBroadcastManager, type BroadcastDriver, type BroadcastEvent, type BroadcastManager } from '../../src/broadcasting'
import { MemoryDriver } from '../../src/broadcasting/drivers'
import { markSender, readSender, stripSender } from '../../src/broadcasting/sender-envelope'
import { setResolvedPrincipal } from '../../src/auth/context'
import { Application } from '../../src/http/Application'
import { resetDefaultApplication } from '../../src/http/default-application'
import { Controller } from '../../src/mvc/Controller'

/** RFC 0037 §2 and §4: the channel on every delivered event, and skipping the sender's own socket. */

interface Delivery {
  event: string
  data: unknown
  channel?: string
}

class OrderUpdated {
  constructor(readonly orderId: number) {}

  broadcastOn(): string[] {
    return [`private-orders.${this.orderId}`]
  }

  broadcastAs(): string {
    return 'OrderUpdated'
  }

  broadcastWith(): Record<string, unknown> {
    return { orderId: this.orderId }
  }
}

function createManager(driver: () => BroadcastDriver = () => new MemoryDriver()): BroadcastManager {
  return createBroadcastManager({ default: 'bus', drivers: { bus: driver } })
}

/** Two app instances behind Redis: every event crosses as JSON, and either side may deliver it. */
function jsonBus(): () => BroadcastDriver {
  const subscribers = new Map<string, Set<(event: BroadcastEvent) => void>>()
  return () => ({
    async publish(channel, event, data) {
      const wire = JSON.parse(JSON.stringify(data)) as unknown
      for (const callback of subscribers.get(channel) ?? []) callback({ channel, event, data: wire, timestamp: new Date() })
    },
    subscribe(channel, callback) {
      const set = subscribers.get(channel) ?? new Set()
      set.add(callback)
      subscribers.set(channel, set)
      return () => set.delete(callback)
    },
    unsubscribe(channel, callback) {
      subscribers.get(channel)?.delete(callback)
    },
  })
}

function socket(manager: BroadcastManager, userId: number | undefined, channel = 'private-orders.1') {
  const received: Delivery[] = []
  const id = manager.registerWebSocketClient({
    userId,
    send: (event, data, channelName) => {
      received.push(channelName === undefined ? { event, data } : { event, data, channel: channelName })
    },
    close: () => {},
  })
  manager.subscribeWebSocketClient(id, channel)
  return { id, socketId: manager.getWebSocketClient(id)!.socketId!, received }
}

describe('sender envelope', () => {
  const sender = { socketId: `s_${'a'.repeat(32)}`, userId: 7 }

  test('marks a plain object, keeps an envelope key it did not add, and strips only its own', () => {
    const marked = markSender({ orderId: 1, __inertia: { event: 'X' } }, sender)

    expect(readSender(marked)).toEqual(sender)
    expect(stripSender(marked)).toEqual({ orderId: 1, __inertia: { event: 'X' } })
    expect(stripSender(markSender({ orderId: 1 }, sender))).toEqual({ orderId: 1 })
  })

  test('leaves a payload that is not a plain object unmarked', () => {
    expect(markSender([1], sender)).toEqual([1])
    expect(markSender('text', sender)).toBe('text')
  })

  test('reads no sender from a socket id it could not have issued', () => {
    expect(readSender({ __inertia: { socketId: 'ws_123', userId: 7 } })).toBeUndefined()
    expect(readSender({ __inertia: { socketId: sender.socketId } })).toBeUndefined()
  })
})

describe('WebSocket client socket ids and channels', () => {
  test('issues each client its own socket id, apart from its client id', () => {
    const manager = createManager()
    const first = socket(manager, 1)
    const second = socket(manager, 1)

    expect(first.socketId).toMatch(/^s_[0-9a-f]{32}$/)
    expect(first.socketId).not.toBe(second.socketId)
    expect(first.socketId).not.toContain(first.id)
  })

  test('hands every delivered event the channel it arrived on', async () => {
    const manager = createManager()
    const client = socket(manager, 1)
    manager.subscribeWebSocketClient(client.id, 'announcements')

    await manager.broadcast('private-orders.1', 'OrderUpdated', { orderId: 1 })
    await manager.broadcast('announcements', 'OrderUpdated', { orderId: 2 })

    expect(client.received).toEqual([
      { event: 'OrderUpdated', data: { orderId: 1 }, channel: 'private-orders.1' },
      { event: 'OrderUpdated', data: { orderId: 2 }, channel: 'announcements' },
    ])
  })
})

describe('broadcastEvent() with except', () => {
  test("skips the sender's own socket and strips the mark for everyone else", async () => {
    const manager = createManager()
    const own = socket(manager, 1)
    const otherTab = socket(manager, 1)
    const otherUser = socket(manager, 2)

    await manager.broadcastEvent(new OrderUpdated(1), { except: { socketId: own.socketId, user: { id: 1 } } })

    expect(own.received).toEqual([])
    const expected = [{ event: 'OrderUpdated', data: { orderId: 1 }, channel: 'private-orders.1' }]
    expect(otherTab.received).toEqual(expected)
    expect(otherUser.received).toEqual(expected)
  })

  test('skips nobody for a socket id named by a user who does not own it', async () => {
    const manager = createManager()
    const victim = socket(manager, 1)
    const unowned = socket(manager, undefined)

    await manager.broadcastEvent(new OrderUpdated(1), { except: { socketId: victim.socketId, user: { id: 2 } } })
    await manager.broadcastEvent(new OrderUpdated(1), { except: { socketId: unowned.socketId, user: { id: 2 } } })
    await manager.broadcastEvent(new OrderUpdated(1), { except: { socketId: victim.socketId } })

    expect(victim.received.map((delivery) => delivery.data)).toEqual([{ orderId: 1 }, { orderId: 1 }, { orderId: 1 }])
    expect(unowned.received).toHaveLength(3)
  })

  test("reads the socket id and the signed-in user off a controller's context", async () => {
    const manager = createManager()
    const own = socket(manager, 1)
    const other = socket(manager, 1)
    class OrderController extends Controller {
      async update() {
        await manager.broadcastEvent(new OrderUpdated(1), { except: this.ctx })
        return new Response('saved')
      }
    }
    const app = new Application()
    app.hono.use('*', async (ctx, next) => {
      setResolvedPrincipal(ctx, { user: { id: 1 }, id: 1 })
      await next()
    })
    app.router.get('/orders/1/touch', [OrderController, 'update'])
    await app.boot()

    try {
      const response = await app.fetch(new Request('http://example.com/orders/1/touch', { headers: { 'X-Socket-Id': own.socketId } }))
      expect(await response.text()).toBe('saved')
    } finally {
      resetDefaultApplication()
    }

    expect(own.received).toEqual([])
    expect(other.received).toHaveLength(1)
  })

  test('publishes the payload unmarked without except, or with a header that is no socket id', async () => {
    const manager = createManager()
    const received: unknown[] = []
    manager.driver().subscribe('private-orders.1', (event) => received.push(event.data))

    await manager.broadcastEvent(new OrderUpdated(1))
    await manager.broadcastEvent(new OrderUpdated(1), { except: { socketId: 'ws_forged', user: { id: 1 } } })
    await manager.broadcastEvent(new OrderUpdated(1), { except: null })

    expect(received).toEqual([{ orderId: 1 }, { orderId: 1 }, { orderId: 1 }])
  })

  test('skips the sender across two instances whose events cross as JSON', async () => {
    const bus = jsonBus()
    const sending = createManager(bus)
    const delivering = createManager(bus)
    const own = socket(delivering, 1)
    const other = socket(delivering, 1)

    await sending.broadcastEvent(new OrderUpdated(1), { except: { socketId: own.socketId, user: { id: 1 } } })

    expect(own.received).toEqual([])
    expect(other.received).toEqual([{ event: 'OrderUpdated', data: { orderId: 1 }, channel: 'private-orders.1' }])
  })

  test('cannot be forged by a payload the app relays, on any publish path', async () => {
    const manager = createManager()
    const victim = socket(manager, 1)
    const forged = { text: 'hi', __inertia: { socketId: victim.socketId, userId: 1 } }

    await manager.broadcast('private-orders.1', 'Relayed', forged)
    await manager.toChannel('private-orders.1').broadcast('Relayed', forged)
    await manager.broadcastEvent({ broadcastOn: () => ['private-orders.1'], broadcastAs: () => 'Relayed', broadcastWith: () => forged })

    expect(victim.received.map((delivery) => delivery.data)).toEqual([{ text: 'hi' }, { text: 'hi' }, { text: 'hi' }])
  })

  test('compares the owner strictly, as channel attachment does', async () => {
    const manager = createManager()
    const own = socket(manager, 1)

    await manager.broadcastEvent(new OrderUpdated(1), { except: { socketId: own.socketId, user: { id: '1' } } })

    expect(own.received).toHaveLength(1)
  })

  test('marks nothing for a user id JSON cannot carry, and leaks no socket id', async () => {
    const bus = jsonBus()
    const manager = createManager(bus)
    const own = socket(manager, Number.NaN)
    const other = socket(manager, 2)

    await manager.broadcastEvent(new OrderUpdated(1), { except: { socketId: own.socketId, user: { id: Number.NaN } } })

    expect(other.received.map((delivery) => delivery.data)).toEqual([{ orderId: 1 }])
    expect(JSON.stringify(other.received)).not.toContain(own.socketId)
  })

  test('marks a payload that is not a plain object as the JSON a client receives', async () => {
    class Payload {
      constructor(readonly orderId: number) {}
    }
    const manager = createManager()
    const own = socket(manager, 1)
    const other = socket(manager, 2)

    await manager.broadcastEvent(
      { broadcastOn: () => ['private-orders.1'], broadcastAs: () => 'OrderUpdated', broadcastWith: () => new Payload(4) as unknown as Record<string, unknown> },
      { except: { socketId: own.socketId, user: { id: 1 } } },
    )

    expect(own.received).toEqual([])
    expect(other.received.map((delivery) => delivery.data)).toEqual([{ orderId: 4 }])
  })

  test('strips the mark from what an SSE stream receives', async () => {
    const manager = createManager()
    manager.channel('announcements', () => true)
    const own = socket(manager, 1, 'announcements')
    const app = new Hono()
    app.get('/events', manager.sseMiddleware({ pingInterval: 60000 }) as never)

    const response = await app.request('/events?channels=announcements')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const readUntil = async (needle: string): Promise<void> => {
      while (!buffer.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`the stream closed before "${needle}"; it sent: ${buffer}`)
        buffer += decoder.decode(value, { stream: true })
      }
    }
    await readUntil('event: connected')

    await manager.broadcastEvent(
      { broadcastOn: () => ['announcements'], broadcastAs: () => 'Posted', broadcastWith: () => ({ id: 3 }) },
      { except: { socketId: own.socketId, user: { id: 1 } } },
    )
    await readUntil('event: Posted')
    await reader.cancel()

    expect(buffer).toContain('event: Posted\ndata: {"id":3}\n')
    expect(buffer).not.toContain('__inertia')
    expect(own.received).toEqual([])
  })
})
