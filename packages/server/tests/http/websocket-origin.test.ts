import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

import { createWebSocketOriginGuard } from '../../src/http/middleware/websocket-origin'

function guardedApp(allowedOrigins?: string[]): Hono {
  const app = new Hono()
  app.get('/socket', createWebSocketOriginGuard({ allowedOrigins }), (ctx) => ctx.text('upgraded'))
  return app
}

async function statusFor(app: Hono, origin?: string): Promise<number> {
  const response = await app.request('http://app.example.com/socket', {
    headers: origin === undefined ? {} : { Origin: origin },
  })
  return response.status
}

describe('createWebSocketOriginGuard', () => {
  test('passes the request\'s own host, whatever the scheme a proxy ended TLS at', async () => {
    const app = guardedApp()

    expect(await statusFor(app, 'http://app.example.com')).toBe(200)
    expect(await statusFor(app, 'https://app.example.com')).toBe(200)
  })

  test('passes a request with no Origin, which no browser sends', async () => {
    expect(await statusFor(guardedApp())).toBe(200)
  })

  test('refuses another site and an opaque origin', async () => {
    const app = guardedApp()

    expect(await statusFor(app, 'https://evil.example')).toBe(403)
    expect(await statusFor(app, 'https://app.example.com.evil.example')).toBe(403)
    expect(await statusFor(app, 'null')).toBe(403)
  })

  test('admits a listed origin with its scheme only', async () => {
    const app = guardedApp(['https://public.example.com/ignored-path'])

    expect(await statusFor(app, 'https://public.example.com')).toBe(200)
    expect(await statusFor(app, 'http://public.example.com')).toBe(403)
  })

  test('refuses an allowedOrigins entry no browser Origin can match', () => {
    expect(() => createWebSocketOriginGuard({ allowedOrigins: ['wss://app.example.com'] })).toThrow(/http\(s\) origin/)
    expect(() => createWebSocketOriginGuard({ allowedOrigins: ['app.example.com'] })).toThrow(/http\(s\) origin/)
  })
})
