import { afterEach, describe, expect, test } from 'bun:test'
import { createBroadcastManager } from '../../src/broadcasting'
import { MemoryDriver } from '../../src/broadcasting/drivers'
import { setResolvedPrincipal } from '../../src/auth/context'
import { Application } from '../../src/http/Application'
import { resetDefaultApplication } from '../../src/http/default-application'

type User = { id: number }

// No `auth` option: the user comes from the fallback auth context the
// Application attaches, answering from the principal set below.
function createApp() {
  const manager = createBroadcastManager({
    default: 'memory',
    drivers: { memory: () => new MemoryDriver() },
  })
  const seen: unknown[] = []
  manager.privateChannel('users.{id}', (channel, user) => {
    seen.push(user)
    return (user as User | undefined)?.id === Number(channel.split('.').pop())
  })

  const app = new Application()
  app.hono.use('*', async (ctx, next) => {
    const id = ctx.req.header('x-user-id')
    if (id) setResolvedPrincipal(ctx, { user: { id: Number(id) }, id: Number(id) })
    await next()
  })
  app.hono.get('/broadcasting/events', manager.sseMiddleware({ pingInterval: 60000 }) as never)
  app.hono.post('/broadcasting/auth', manager.authMiddleware() as never)

  return { app, seen }
}

function authorize(app: Application, channel: string, headers: Record<string, string> = {}, clientId?: string) {
  return app.hono.request('/broadcasting/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ channel, clientId }),
  })
}

async function readConnected(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) throw new Error('stream closed before the connected event')
    buffer += decoder.decode(value, { stream: true })
    const match = buffer.match(/event: connected\ndata: (.+)\n/)
    if (match) return JSON.parse(match[1]) as { clientId: string; channels: string[] }
  }
}

afterEach(() => {
  resetDefaultApplication()
})

describe('broadcast middlewares without getUser', () => {
  test('the auth endpoint authorizes the session user from the auth context', async () => {
    const { app, seen } = createApp()

    const response = await authorize(app, 'private-users.7', { 'x-user-id': '7' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ 'private-users.7': { authorized: true, subscribed: false } })
    expect(seen).toEqual([{ id: 7 }])
  })

  test('the auth endpoint refuses a guest, passing the authorizer undefined', async () => {
    const { app, seen } = createApp()

    const response = await authorize(app, 'private-users.7')

    expect(await response.json()).toEqual({ 'private-users.7': { authorized: false } })
    expect(seen).toEqual([undefined])
  })

  test('the SSE stream authorizes ?channels= as the session user', async () => {
    const { app } = createApp()

    const response = await app.hono.request('/broadcasting/events?channels=private-users.7,private-users.8', {
      headers: { 'x-user-id': '7' },
    })
    const reader = response.body!.getReader()
    const connected = await readConnected(reader)

    expect(connected.channels).toEqual(['private-users.7'])
    await reader.cancel().catch(() => {})
  })

  test('a stream opened by the session user cannot be attached by another user', async () => {
    const { app } = createApp()

    const response = await app.hono.request('/broadcasting/events', { headers: { 'x-user-id': '8' } })
    const reader = response.body!.getReader()
    const { clientId } = await readConnected(reader)

    const intruder = await authorize(app, 'private-users.7', { 'x-user-id': '7' }, clientId)
    expect(await intruder.json()).toEqual({ 'private-users.7': { authorized: true, subscribed: false } })

    const owner = await authorize(app, 'private-users.8', { 'x-user-id': '8' }, clientId)
    expect(await owner.json()).toEqual({ 'private-users.8': { authorized: true, subscribed: true } })

    await reader.cancel().catch(() => {})
  })
})
