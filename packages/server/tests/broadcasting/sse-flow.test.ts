import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { createBroadcastManager } from '../../src/broadcasting'
import { MemoryDriver } from '../../src/broadcasting/drivers'

function createManager() {
  return createBroadcastManager({
    default: 'memory',
    drivers: { memory: () => new MemoryDriver() },
  })
}

async function readEvents(
  body: ReadableStream<Uint8Array>,
  until: (events: Array<{ event: string; data: unknown }>) => boolean,
  timeoutMs = 2000,
): Promise<Array<{ event: string; data: unknown }>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const events: Array<{ event: string; data: unknown }> = []
  let buffer = ''
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline && !until(events)) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), deadline - Date.now()),
      ),
    ])
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let index: number
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const eventMatch = chunk.match(/^event: (.+)$/m)
      const dataMatch = chunk.match(/^data: (.+)$/m)
      if (eventMatch && dataMatch) {
        events.push({ event: eventMatch[1], data: JSON.parse(dataMatch[1]) })
      }
    }
  }

  await reader.cancel().catch(() => {})
  return events
}

/**
 * Read the `connected` frame's clientId, leaving the reader open.
 *
 * `readEvents` above cancels its reader before returning, and cancelling runs
 * the stream's cleanup, which drops the client from `sseClients` — so a test
 * that goes on to POST /auth against that client has to keep the stream alive.
 */
async function readClientId(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return ''
    buffer += decoder.decode(value, { stream: true })
    const match = buffer.match(/event: connected\ndata: (.+)\n/)
    if (match) return (JSON.parse(match[1]) as { clientId: string }).clientId
  }
}

describe('SSE subscription flow', () => {
  test('should announce the client id and deliver events for query-subscribed public channels', async () => {
    const manager = createManager()
    manager.channel('announcements', () => true)

    const app = new Hono()
    app.get('/events', manager.sseMiddleware({ pingInterval: 60000 }) as never)

    const response = await app.request('/events?channels=announcements')
    expect(response.status).toBe(200)

    const eventsPromise = readEvents(response.body!, (events) =>
      events.some((entry) => entry.event === 'BoardUpdated'),
    )

    // Give the stream a beat to register its subscription, then publish.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await manager.broadcast('announcements', 'BoardUpdated', { taskId: 7 })

    const events = await eventsPromise
    const connected = events.find((entry) => entry.event === 'connected')
    expect(connected).toBeDefined()
    expect((connected!.data as { clientId: string }).clientId).toMatch(/.+/)
    expect((connected!.data as { channels: string[] }).channels).toEqual(['announcements'])

    const update = events.find((entry) => entry.event === 'BoardUpdated')
    expect(update).toBeDefined()
    expect((update!.data as { data: { taskId: number } }).data?.taskId ?? (update!.data as { taskId: number }).taskId).toBe(7)
  })

  test('should not subscribe unauthorized channels from the query', async () => {
    const manager = createManager()
    manager.privateChannel('secret', () => false)

    const app = new Hono()
    app.get('/events', manager.sseMiddleware({ pingInterval: 60000 }) as never)

    const response = await app.request('/events?channels=private-secret,private-unregistered')
    const events = await readEvents(response.body!, (entries) =>
      entries.some((entry) => entry.event === 'connected'),
    )

    const connected = events.find((entry) => entry.event === 'connected')
    expect((connected!.data as { channels: string[] }).channels).toEqual([])
  })

  // The auth endpoint reads the channel out of the request payload, so it
  // inherits the shared parser's empty-object fallback. A body no form parser
  // can decode names no channel, which is the ordinary 400 — not the 500 the
  // parser's TypeError used to produce.
  test('answers 400 for a request body the form parser cannot decode', async () => {
    const manager = createManager()
    manager.privateChannel('users.1.notifications', () => true)

    const app = new Hono()
    app.post('/auth', manager.authMiddleware({ getUser: () => ({ id: 1 }) }) as never)

    const response = await app.request('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data' },
      body: 'broken',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'No channel specified' })
  })

  test('should subscribe an existing client through the auth endpoint', async () => {
    const manager = createManager()
    manager.privateChannel('users.1.notifications', (_channel, user) => (user as { id: number } | null)?.id === 1)

    const app = new Hono()
    app.get('/events', manager.sseMiddleware({ pingInterval: 60000 }) as never)
    app.post(
      '/auth',
      manager.authMiddleware({ getUser: () => ({ id: 1 }) }) as never,
    )

    const response = await app.request('/events')
    const reader = response.body!.getReader()
    const clientId = await readClientId(reader)
    expect(clientId).toMatch(/.+/)

    const authResponse = await app.request('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, channel: 'private-users.1.notifications' }),
    })
    const authJson = (await authResponse.json()) as Record<string, { authorized: boolean; subscribed: boolean }>
    expect(authJson['private-users.1.notifications'].authorized).toBe(true)
    expect(authJson['private-users.1.notifications'].subscribed).toBe(true)

    await reader.cancel().catch(() => {})
  })

  // Authorization answers "may this user read the channel", not "may this user
  // attach it to that stream". Without the ownership check, user 1 — genuinely
  // authorized for their own channel — pushes their events into user 2's
  // stream by naming user 2's clientId.
  test('refuses to attach a channel to a stream owned by another user', async () => {
    const manager = createManager()
    manager.privateChannel('users.1.notifications', (_channel, user) => (user as { id: number } | null)?.id === 1)

    const app = new Hono()
    // The victim's stream: opened while signed in as user 2, so it has an owner.
    app.get('/events', manager.sseMiddleware({ pingInterval: 60000, getUser: () => ({ id: 2 }) }) as never)
    app.post('/auth', manager.authMiddleware({ getUser: () => ({ id: 1 }) }) as never)

    const response = await app.request('/events')
    const reader = response.body!.getReader()
    const victimClientId = await readClientId(reader)
    expect(victimClientId).toMatch(/.+/)

    const authResponse = await app.request('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: victimClientId, channel: 'private-users.1.notifications' }),
    })
    const authJson = (await authResponse.json()) as Record<string, { authorized: boolean; subscribed: boolean }>

    // User 1 really is authorized for their own channel — the attach is what
    // must fail.
    expect(authJson['private-users.1.notifications'].authorized).toBe(true)
    expect(authJson['private-users.1.notifications'].subscribed).toBe(false)

    await reader.cancel().catch(() => {})
  })

  test('client ids are unguessable rather than time-seeded', async () => {
    const manager = createManager()
    const app = new Hono()
    app.get('/events', manager.sseMiddleware({ pingInterval: 60000 }) as never)

    const ids = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const response = await app.request('/events')
      const reader = response.body!.getReader()
      const id = await readClientId(reader)
      // 16 random bytes, hex-encoded — no Date.now() prefix to anchor a guess.
      expect(id).toMatch(/^sse_[0-9a-f]{32}$/)
      ids.add(id)
      await reader.cancel().catch(() => {})
    }
    expect(ids.size).toBe(3)
  })
})
