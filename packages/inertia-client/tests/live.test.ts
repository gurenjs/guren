import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { liveTransport, liveWireName, type LiveTransport } from '../src/live'

/** RFC 0037 §3: the transport against a socket that speaks `webSocketMiddleware()`'s frames. */

class FakeSocket {
  readonly sent: { action: string; channel: string }[] = []
  closed = false
  private listeners: Record<string, ((event: unknown) => void)[]> = {}

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(listener)
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as { action: string; channel: string })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emitRaw('close', {})
  }

  frame(frame: Record<string, unknown>): void {
    this.emitRaw('message', { data: JSON.stringify(frame) })
  }

  connected(socketId = `s_${'a'.repeat(32)}`): void {
    this.frame({ event: 'connected', data: { clientId: 'ws_1', socketId, channels: [] } })
  }

  answer(channel: string, authorized = true): void {
    this.frame({ event: 'subscription', data: authorized ? { channel, authorized, subscribed: true } : { channel, authorized } })
  }

  private emitRaw(type: string, event: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener(event)
  }
}

let sockets: FakeSocket[] = []
let warn: ReturnType<typeof spyOn>

beforeEach(() => {
  sockets = []
  warn = spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
})

function create(options: Parameters<typeof liveTransport>[0] = {}): LiveTransport {
  return liveTransport({
    url: 'http://example.com/broadcasting/socket',
    webSocketFactory: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    ...options,
  }).transport
}

const order = { name: 'orders.1', type: 'private' } as const
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

describe('liveWireName()', () => {
  it('puts back the prefix the server channel classes use', () => {
    expect(liveWireName({ name: 'news', type: 'public' })).toBe('news')
    expect(liveWireName(order)).toBe('private-orders.1')
    expect(liveWireName({ name: 'chat.2', type: 'presence' })).toBe('presence-chat.2')
    expect(liveWireName({ name: 'x', type: 'encrypted-private' })).toBeUndefined()
  })
})

describe('liveTransport()', () => {
  it('passes throttle and pauseWhenHidden through to Inertia', () => {
    expect(liveTransport({ throttle: 2000, pauseWhenHidden: false })).toMatchObject({ throttle: 2000, pauseWhenHidden: false })
    expect(liveTransport()).not.toHaveProperty('throttle')
  })

  it('opens no socket until a live prop subscribes, then one for every channel', () => {
    const transport = create()
    expect(sockets).toHaveLength(0)

    transport.subscribe(order, 'OrderUpdated', () => {})
    transport.subscribe({ name: 'news', type: 'public' }, 'Posted', () => {})

    expect(sockets.map((socket) => socket.url)).toEqual(['ws://example.com/broadcasting/socket'])
  })

  it('subscribes each channel once after connected, however many events listen on it', () => {
    const transport = create()
    transport.subscribe(order, 'OrderUpdated', () => {})
    transport.subscribe(order, 'OrderCancelled', () => {})
    const [socket] = sockets

    expect(socket!.sent).toEqual([])
    socket!.connected()
    expect(socket!.sent).toEqual([{ action: 'subscribe', channel: 'private-orders.1' }])
  })

  it('routes an event by channel and name, and removes __inertia before Inertia sees it', () => {
    const transport = create()
    const updated: unknown[] = []
    const other: unknown[] = []
    transport.subscribe(order, 'OrderUpdated', (payload) => updated.push(payload))
    transport.subscribe({ name: 'orders.2', type: 'private' }, 'OrderUpdated', (payload) => other.push(payload))
    const [socket] = sockets
    socket!.connected()

    socket!.frame({ event: 'OrderUpdated', channel: 'private-orders.1', data: { id: 1, __inertia: { props: { order: 'forged' } } } })
    socket!.frame({ event: 'OrderShipped', channel: 'private-orders.1', data: {} })

    expect(updated).toEqual([{ id: 1 }])
    expect(other).toEqual([])
  })

  it('drops an event frame that names no channel and says which server it needs, once', () => {
    const transport = create()
    const received: unknown[] = []
    transport.subscribe(order, 'OrderUpdated', (payload) => received.push(payload))
    const [socket] = sockets
    socket!.connected()

    socket!.frame({ event: 'OrderUpdated', data: {} })
    socket!.frame({ event: 'OrderUpdated', data: {} })

    expect(received).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('@guren/server 2.36')
  })

  it('reports the socket id from connected, and none before it', () => {
    const transport = create()
    transport.subscribe(order, 'OrderUpdated', () => {})
    expect(transport.socketId?.()).toBeNull()

    sockets[0]!.connected(`s_${'b'.repeat(32)}`)
    expect(transport.socketId?.()).toBe(`s_${'b'.repeat(32)}`)
  })

  it('keeps at most 16 messages waiting for an answer', () => {
    const transport = create()
    for (let index = 0; index < 20; index += 1) transport.subscribe({ name: `c${index}`, type: 'public' }, 'E', () => {})
    const [socket] = sockets
    socket!.connected()
    expect(socket!.sent).toHaveLength(16)

    socket!.answer('c0')
    socket!.answer('c1')
    expect(socket!.sent).toHaveLength(18)
  })

  it('reports connected only once every replayed subscription is answered', () => {
    const transport = create()
    const statuses: boolean[] = []
    transport.onStatusChange?.((connected) => statuses.push(connected))
    transport.subscribe(order, 'OrderUpdated', () => {})
    transport.subscribe({ name: 'news', type: 'public' }, 'Posted', () => {})
    const [socket] = sockets

    socket!.connected()
    expect(statuses).toEqual([])
    socket!.answer('private-orders.1')
    expect(statuses).toEqual([])
    socket!.answer('news')
    expect(statuses).toEqual([true])
  })

  it('warns once about a channel the server refused', () => {
    const transport = create()
    transport.subscribe(order, 'OrderUpdated', () => {})
    const [socket] = sockets
    socket!.connected()

    socket!.answer('private-orders.1', false)

    expect(String(warn.mock.calls[0]?.[0])).toContain('refused the live channel "private-orders.1"')
  })

  it('unsubscribes after the last listener of a channel and closes the idle socket', async () => {
    const transport = create({ idleTimeout: 10 })
    const offUpdated = transport.subscribe(order, 'OrderUpdated', () => {})
    const offCancelled = transport.subscribe(order, 'OrderCancelled', () => {})
    const [socket] = sockets
    socket!.connected()
    socket!.answer('private-orders.1')

    offUpdated()
    expect(socket!.sent).toHaveLength(1)
    offCancelled()
    offCancelled()
    expect(socket!.sent).toEqual([
      { action: 'subscribe', channel: 'private-orders.1' },
      { action: 'unsubscribe', channel: 'private-orders.1' },
    ])

    await tick(30)
    expect(socket!.closed).toBe(true)
  })

  it('keeps the socket when another live prop subscribes within the idle timeout', async () => {
    const transport = create({ idleTimeout: 20 })
    const off = transport.subscribe(order, 'OrderUpdated', () => {})
    sockets[0]!.connected()
    off()
    transport.subscribe({ name: 'news', type: 'public' }, 'Posted', () => {})

    await tick(40)
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.closed).toBe(false)
  })

  it('reports a dropped socket, reconnects, replays its channels and reports connected again', async () => {
    const transport = create()
    const statuses: boolean[] = []
    transport.onStatusChange?.((connected) => statuses.push(connected))
    transport.subscribe(order, 'OrderUpdated', () => {})
    sockets[0]!.connected()
    sockets[0]!.answer('private-orders.1')

    sockets[0]!.close()
    expect(statuses).toEqual([true, false])
    expect(transport.socketId?.()).toBeNull()

    await tick(1100)
    const reopened = sockets[1]!
    reopened.connected(`s_${'c'.repeat(32)}`)
    expect(reopened.sent).toEqual([{ action: 'subscribe', channel: 'private-orders.1' }])
    reopened.answer('private-orders.1')
    expect(statuses).toEqual([true, false, true])
  })

  it('subscribes nothing for a channel type Guren does not have', () => {
    const transport = create()
    const off = transport.subscribe({ name: 'x', type: 'encrypted-private' }, 'E', () => {})

    off()
    expect(sockets).toHaveLength(0)
    expect(String(warn.mock.calls[0]?.[0])).toContain('no encrypted-private channels')
  })
})
