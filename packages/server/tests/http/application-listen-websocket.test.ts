import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { upgradeWebSocket } from 'hono/bun'

import { Application } from '../../src/http/Application'

/**
 * Real sockets: `server.upgrade()` throws unless `Bun.serve` was handed a
 * `websocket` object, which only a real bind can show. Everything binds
 * 127.0.0.1 on port 0 and is stopped in `afterEach`.
 */

const openApps: Application[] = []
const originalBanner = process.env.GUREN_DEV_BANNER

beforeEach(() => {
  process.env.GUREN_DEV_BANNER = '0'
})

afterEach(async () => {
  while (openApps.length > 0) {
    await openApps.pop()?.stop(true)
  }
  if (originalBanner === undefined) delete process.env.GUREN_DEV_BANNER
  else process.env.GUREN_DEV_BANNER = originalBanner
})

async function serve(app: Application): Promise<string> {
  await app.boot()
  const address = await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })
  openApps.push(app)
  return address.url
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('close', (event) => {
      reject(new Error(`the socket closed before opening (code ${event.code})`))
    }, { once: true })
  })
}

function firstMessage(socket: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no message before the timeout')), timeoutMs)
    socket.addEventListener('message', (event) => {
      clearTimeout(timer)
      resolve(String(event.data))
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('the socket failed to open'))
    }, { once: true })
  })
}

describe('Application.listen WebSocket support', () => {
  it('upgrades a route built with hono/bun upgradeWebSocket', async () => {
    const app = new Application()
    app.router.get('/socket', upgradeWebSocket(() => ({
      onMessage(event, ws) {
        ws.send(`echo:${String(event.data)}`)
      },
    })))
    const url = await serve(app)

    const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/socket`)
    await opened(socket)
    const reply = firstMessage(socket)
    socket.send('hello')

    expect(await reply).toBe('echo:hello')
    socket.close()
  })

  // The loopback guard and the rate limiter read the socket peer through
  // `ctx.env.server.requestIP()`; passing `websocket` must not change that env.
  it('keeps the Bun server in the request env beside the WebSocket handler', async () => {
    const app = new Application()
    app.router.get('/peer', (ctx) => {
      const env = ctx.env as { server?: { requestIP?: (request: Request) => { address?: string } | null } }
      return ctx.json({ address: env.server?.requestIP?.(ctx.req.raw)?.address ?? null })
    })
    const url = await serve(app)

    const response = await fetch(`${url}/peer`)
    const body = (await response.json()) as { address: string | null }

    expect(body.address).toMatch(/127\.0\.0\.1$/)
  })
})
