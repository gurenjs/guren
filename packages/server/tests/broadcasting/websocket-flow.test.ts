import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

import { createBroadcastManager, type BroadcastManager } from '../../src/broadcasting'
import { MemoryDriver } from '../../src/broadcasting/drivers'
import { Application } from '../../src/http/Application'

/**
 * Upgrades go through a real `Application.listen()`: only a Bun server can
 * upgrade, and the upgrade path is what these tests are about. Users are read
 * from an `x-user` header, which Bun's WebSocket client can send.
 */

interface Frame {
  event: string
  data: Record<string, unknown>
}

const openApps: Application[] = []
const openSockets: WebSocket[] = []
const originalBanner = process.env.GUREN_DEV_BANNER
const originalStopTimeout = process.env.GUREN_BUN_STOP_TIMEOUT_MS

beforeEach(() => {
  process.env.GUREN_DEV_BANNER = '0'
})

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close()
  while (openApps.length > 0) {
    await openApps.pop()?.stop(true)
  }
  if (originalBanner === undefined) delete process.env.GUREN_DEV_BANNER
  else process.env.GUREN_DEV_BANNER = originalBanner
  if (originalStopTimeout === undefined) delete process.env.GUREN_BUN_STOP_TIMEOUT_MS
  else process.env.GUREN_BUN_STOP_TIMEOUT_MS = originalStopTimeout
})

function createManager(): BroadcastManager {
  return createBroadcastManager({
    default: 'memory',
    drivers: { memory: () => new MemoryDriver() },
  })
}

function userFromHeader(ctx: unknown): { id: number } | undefined {
  const id = (ctx as { req: { header(name: string): string | undefined } }).req.header('x-user')
  return id ? { id: Number(id) } : undefined
}

async function serve(
  manager: BroadcastManager,
  options: Parameters<BroadcastManager['webSocketMiddleware']>[0] = {},
): Promise<string> {
  const app = new Application()
  app.router.get('/broadcasting/socket', manager.webSocketMiddleware({ getUser: userFromHeader, ...options }))
  await app.boot()
  const address = await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })
  openApps.push(app)
  return address.url
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('condition not met before the timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function connect(
  url: string,
  options: { query?: string; headers?: Record<string, string> } = {},
): Promise<{ socket: WebSocket; frames: Frame[]; clientId: string; channels: string[] }> {
  const target = `${url.replace(/^http/, 'ws')}/broadcasting/socket${options.query ?? ''}`
  // Bun's client accepts `headers`; the DOM typing does not know it.
  const socket = new WebSocket(target, { headers: options.headers } as unknown as string[])
  openSockets.push(socket)
  const frames: Frame[] = []
  socket.addEventListener('message', (event) => {
    frames.push(JSON.parse(String(event.data)) as Frame)
  })

  const connected = await waitFor(() => frames.find((frame) => frame.event === 'connected'))
  return {
    socket,
    frames,
    clientId: connected.data.clientId as string,
    channels: connected.data.channels as string[],
  }
}

function subscriptionFrame(frames: Frame[], channel: string): Frame | undefined {
  return frames.find((frame) => frame.event === 'subscription' && frame.data.channel === channel)
}

/** Frames on one socket arrive in order, so this reply follows anything the server sent before it. */
async function roundTrip(socket: WebSocket, frames: Frame[]): Promise<void> {
  const probe = `probe-${crypto.randomUUID()}`
  socket.send(JSON.stringify({ action: 'unsubscribe', channel: probe }))
  await waitFor(() => subscriptionFrame(frames, probe))
}

describe('WebSocket subscription flow', () => {
  test('announces the client id and delivers events for public channels requested up front', async () => {
    const manager = createManager()
    manager.channel('announcements', () => true)
    const url = await serve(manager)

    const { frames, clientId, channels } = await connect(url, { query: '?channels=announcements,announcements' })
    expect(clientId).toMatch(/^ws_[0-9a-f]{32}$/)
    expect(channels).toEqual(['announcements'])

    await manager.broadcast('announcements', 'BoardUpdated', { taskId: 7 })

    const update = await waitFor(() => frames.find((frame) => frame.event === 'BoardUpdated'))
    expect(update.data).toEqual({ taskId: 7 })
  })

  test('leaves unauthorized private channels requested up front unsubscribed', async () => {
    const manager = createManager()
    manager.privateChannel('secret', () => false)
    const url = await serve(manager)

    const { socket, frames, channels } = await connect(url, { query: '?channels=private-secret,private-unregistered' })
    expect(channels).toEqual([])

    await manager.broadcast('private-secret', 'Leaked', {})
    await roundTrip(socket, frames)
    expect(frames.some((frame) => frame.event === 'Leaked')).toBe(false)
    expect((manager.driver() as MemoryDriver).getSubscriberCount('private-secret')).toBe(0)
  })

  test('authorizes subscribe messages against the user of the upgrade request', async () => {
    const manager = createManager()
    manager.privateChannel('orders.{id}', (channel, user) =>
      channel === `private-orders.${(user as { id: number } | undefined)?.id}`,
    )
    const url = await serve(manager)

    const { socket, frames } = await connect(url, { headers: { 'x-user': '1' } })
    socket.send(JSON.stringify({ action: 'subscribe', channel: 'private-orders.2' }))
    socket.send(JSON.stringify({ action: 'subscribe', channel: 'private-orders.1' }))

    const refused = await waitFor(() => subscriptionFrame(frames, 'private-orders.2'))
    const granted = await waitFor(() => subscriptionFrame(frames, 'private-orders.1'))
    expect(refused.data).toEqual({ channel: 'private-orders.2', authorized: false })
    expect(granted.data).toEqual({ channel: 'private-orders.1', authorized: true, subscribed: true })

    await manager.broadcast('private-orders.2', 'SomeoneElsesOrder', {})
    await manager.broadcast('private-orders.1', 'OrderShipped', { id: 1 })

    await waitFor(() => frames.find((frame) => frame.event === 'OrderShipped'))
    expect(frames.some((frame) => frame.event === 'SomeoneElsesOrder')).toBe(false)
  })

  test('returns the presence member a presence authorizer grants', async () => {
    const manager = createManager()
    manager.presenceChannel('chat.{room}', (_channel, user) => {
      const id = (user as { id: number } | undefined)?.id
      return id === undefined ? null : { id, info: { name: `user ${id}` } }
    })
    const url = await serve(manager)

    const { socket, frames } = await connect(url, { headers: { 'x-user': '3' } })
    socket.send(JSON.stringify({ action: 'subscribe', channel: 'presence-chat.lobby' }))

    const granted = await waitFor(() => subscriptionFrame(frames, 'presence-chat.lobby'))
    expect(granted.data).toEqual({
      channel: 'presence-chat.lobby',
      authorized: true,
      subscribed: true,
      member: { id: 3, info: { name: 'user 3' } },
    })
  })

  test('stops delivery after an unsubscribe message', async () => {
    const manager = createManager()
    manager.channel('announcements', () => true)
    const url = await serve(manager)

    const { socket, frames } = await connect(url, { query: '?channels=announcements' })
    socket.send(JSON.stringify({ action: 'unsubscribe', channel: 'announcements' }))
    const reply = await waitFor(() => subscriptionFrame(frames, 'announcements'))
    expect(reply.data).toEqual({ channel: 'announcements', subscribed: false })

    await manager.broadcast('announcements', 'AfterUnsubscribe', {})
    await roundTrip(socket, frames)
    expect(frames.some((frame) => frame.event === 'AfterUnsubscribe')).toBe(false)
  })

  test('handles messages in the order the socket sent them', async () => {
    const manager = createManager()
    manager.privateChannel('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return true
    })
    const url = await serve(manager)

    const { socket, frames } = await connect(url)
    socket.send(JSON.stringify({ action: 'subscribe', channel: 'private-slow' }))
    socket.send(JSON.stringify({ action: 'unsubscribe', channel: 'private-slow' }))

    await waitFor(() => {
      const replies = frames.filter((frame) => frame.event === 'subscription')
      return replies.length === 2 ? replies : undefined
    })
    const replies = frames.filter((frame) => frame.event === 'subscription').map((frame) => frame.data)
    expect(replies).toEqual([
      { channel: 'private-slow', authorized: true, subscribed: true },
      { channel: 'private-slow', subscribed: false },
    ])
    expect((manager.driver() as MemoryDriver).getSubscriberCount('private-slow')).toBe(0)
  })

  test('ignores a message longer than the protocol needs', async () => {
    const manager = createManager()
    const url = await serve(manager)
    const channel = 'a'.repeat(5000)

    const { socket, frames } = await connect(url)
    socket.send(JSON.stringify({ action: 'subscribe', channel }))
    await roundTrip(socket, frames)

    expect(subscriptionFrame(frames, channel)).toBeUndefined()
    expect((manager.driver() as MemoryDriver).getSubscriberCount(channel)).toBe(0)
  })

  test('closes a socket that queues more messages than the cap', async () => {
    const manager = createManager()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    manager.privateChannel('gated', async () => {
      await gate
      return true
    })
    const url = await serve(manager)
    // On Bun 1.3.x, `server.stop()` never resolves once the server itself closed
    // a WebSocket (a client-initiated close is fine; 1.4.0 resolves at once), so
    // the default 5 s bound races the hook's 5 s timeout. The socket is already
    // closed, so nothing is left to drain: give the wait up quickly.
    process.env.GUREN_BUN_STOP_TIMEOUT_MS = '100'

    const { socket, clientId } = await connect(url)
    const closed = new Promise<number>((resolve) => {
      socket.addEventListener('close', (event) => resolve(event.code), { once: true })
    })
    for (let i = 0; i < 40; i += 1) {
      socket.send(JSON.stringify({ action: 'subscribe', channel: 'private-gated' }))
    }

    expect(await closed).toBe(1008)
    release()
    await waitFor(() => (manager.getWebSocketClient(clientId) === undefined ? true : undefined))
    expect((manager.driver() as MemoryDriver).getSubscriberCount('private-gated')).toBe(0)
  })

  test('leaves no subscription behind for a subscribe still authorizing when the socket closes', async () => {
    const manager = createManager()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let authorizing = false
    manager.privateChannel('gated', async () => {
      authorizing = true
      await gate
      return true
    })
    const url = await serve(manager)

    const { socket, clientId } = await connect(url)
    socket.send(JSON.stringify({ action: 'subscribe', channel: 'private-gated' }))
    await waitFor(() => (authorizing ? true : undefined))
    socket.close()
    await waitFor(() => (manager.getWebSocketClient(clientId) === undefined ? true : undefined))

    release()
    await gate
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((manager.driver() as MemoryDriver).getSubscriberCount('private-gated')).toBe(0)
  })

  test('removes the client and its driver subscriptions when the socket closes', async () => {
    const manager = createManager()
    manager.channel('announcements', () => true)
    const url = await serve(manager)

    const { socket, clientId } = await connect(url, { query: '?channels=announcements' })
    expect(manager.getWebSocketClient(clientId)).toBeDefined()

    socket.close()

    await waitFor(() => (manager.getWebSocketClient(clientId) === undefined ? true : undefined))
    expect((manager.driver() as MemoryDriver).getSubscriberCount('announcements')).toBe(0)
  })
})

describe('WebSocket upgrade origin check', () => {
  const handshake = {
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version': '13',
  }

  // A page on another site can open a socket to the app, and the browser sends
  // the app's cookies with the handshake; CORS does not apply to it.
  test.each([
    ['another site', 'https://evil.example'],
    ['an opaque origin', 'null'],
  ])('refuses an upgrade from %s', async (_label, origin) => {
    const manager = createManager()
    const url = await serve(manager)

    const response = await fetch(`${url}/broadcasting/socket`, {
      headers: { ...handshake, Origin: origin },
    })

    expect(response.status).toBe(403)
    expect(manager.getWebSocketClients()).toEqual([])
  })

  test('accepts the app\'s own origin', async () => {
    const manager = createManager()
    const url = await serve(manager)

    const { clientId } = await connect(url, { headers: { Origin: url } })
    expect(clientId).toMatch(/^ws_/)
  })

  test('accepts an origin listed in allowedOrigins', async () => {
    const manager = createManager()
    const url = await serve(manager, { allowedOrigins: ['https://app.example.com'] })

    const { clientId } = await connect(url, { headers: { Origin: 'https://app.example.com' } })
    expect(clientId).toMatch(/^ws_/)
  })

  test('answers 426 to a request that is not a WebSocket upgrade', async () => {
    const manager = createManager()
    const url = await serve(manager)

    const response = await fetch(`${url}/broadcasting/socket`)

    expect(response.status).toBe(426)
    expect(response.headers.get('upgrade')).toBe('websocket')
  })

  test('answers 400 to a handshake without a key, before resolving the user', async () => {
    const manager = createManager()
    let userLookups = 0
    const url = await serve(manager, {
      getUser: () => {
        userLookups += 1
        return undefined
      },
    })

    const response = await fetch(`${url}/broadcasting/socket`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    })

    expect(response.status).toBe(400)
    expect(userLookups).toBe(0)
  })
})

describe('WebSocket clients and the auth endpoint', () => {
  function authApp(manager: BroadcastManager, userId: number): Hono {
    const app = new Hono()
    app.post('/auth', manager.authMiddleware({ getUser: () => ({ id: userId }) }) as never)
    return app
  }

  async function postAuth(app: Hono, body: Record<string, unknown>) {
    const response = await app.request('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await response.json()) as Record<string, { authorized: boolean; subscribed: boolean }>
  }

  test('subscribes a websocket client its owner names', async () => {
    const manager = createManager()
    manager.privateChannel('users.1', (_channel, user) => (user as { id: number }).id === 1)
    const received: string[] = []
    const clientId = manager.registerWebSocketClient({
      userId: 1,
      send: (event) => {
        received.push(event)
      },
      close: () => {},
    })

    const result = await postAuth(authApp(manager, 1), { clientId, channel: 'private-users.1' })
    expect(result['private-users.1']).toEqual({ authorized: true, subscribed: true })

    await manager.broadcast('private-users.1', 'Notified', {})
    expect(received).toEqual(['Notified'])
  })

  test('refuses to attach a channel to a websocket client owned by another user', async () => {
    const manager = createManager()
    manager.privateChannel('users.1', (_channel, user) => (user as { id: number }).id === 1)
    const received: string[] = []
    const victimId = manager.registerWebSocketClient({
      userId: 2,
      send: (event) => {
        received.push(event)
      },
      close: () => {},
    })

    const result = await postAuth(authApp(manager, 1), { clientId: victimId, channel: 'private-users.1' })
    expect(result['private-users.1']).toEqual({ authorized: true, subscribed: false })

    await manager.broadcast('private-users.1', 'Notified', {})
    expect(received).toEqual([])
  })
})

describe('webSocketMiddleware outside a Bun server', () => {
  test('answers 501 when the runtime cannot upgrade', async () => {
    const manager = createManager()
    const app = new Hono()
    app.get('/socket', manager.webSocketMiddleware() as never)

    const response = await app.request('/socket', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    })

    expect(response.status).toBe(501)
  })
})
