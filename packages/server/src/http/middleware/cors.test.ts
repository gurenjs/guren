import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { createCorsMiddleware } from './cors'

describe('createCorsMiddleware', () => {
  test('should set CORS headers with default options', async () => {
    const app = new Hono()
    app.use('*', createCorsMiddleware())
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('/', {
      headers: { Origin: 'http://example.com' },
    })

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  test('should restrict to specific origin', async () => {
    const app = new Hono()
    app.use('*', createCorsMiddleware({
      origin: 'https://example.com',
    }))
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('/', {
      headers: { Origin: 'https://example.com' },
    })

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
  })

  test('should throw when credentials is true without explicit origin', () => {
    expect(() => {
      createCorsMiddleware({ credentials: true })
    }).toThrow('credentials requires an explicit origin')
  })

  test('should handle preflight OPTIONS request', async () => {
    const app = new Hono()
    app.use('*', createCorsMiddleware({
      origin: 'https://example.com',
      allowMethods: ['GET', 'POST'],
      maxAge: 3600,
    }))
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('/', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
      },
    })

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
    expect(res.headers.get('Access-Control-Max-Age')).toBe('3600')
  })
})
