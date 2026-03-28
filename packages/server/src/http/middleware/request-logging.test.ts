import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { requestLoggingMiddleware } from './request-logging'
import { requestIdMiddleware } from './request-id'

describe('requestLoggingMiddleware', () => {
  let originalLog: typeof console.log
  let logEntries: string[]

  beforeEach(() => {
    logEntries = []
    originalLog = console.log
    console.log = mock((...args: unknown[]) => {
      logEntries.push(String(args[0]))
    })
  })

  afterEach(() => {
    console.log = originalLog
  })

  test('should log request with method, path, status, and duration', async () => {
    const app = new Hono()
    app.use('*', requestLoggingMiddleware())
    app.get('/test', (c) => c.text('ok'))

    await app.request('/test')

    expect(logEntries).toHaveLength(1)
    const entry = JSON.parse(logEntries[0])
    expect(entry.method).toBe('GET')
    expect(entry.path).toBe('/test')
    expect(entry.status).toBe(200)
    expect(entry.level).toBe('info')
    expect(typeof entry.duration).toBe('number')
    expect(entry.requestId).toBe('-')
  })

  test('should include requestId when paired with requestIdMiddleware', async () => {
    const app = new Hono()
    app.use('*', requestIdMiddleware())
    app.use('*', requestLoggingMiddleware())
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('/')
    const headerId = res.headers.get('X-Request-ID')

    expect(logEntries).toHaveLength(1)
    const entry = JSON.parse(logEntries[0])
    expect(entry.requestId).toBe(headerId)
  })

  test('should log warn level for 4xx responses', async () => {
    const app = new Hono()
    app.use('*', requestLoggingMiddleware())
    app.get('/missing', (c) => c.text('not found', 404))

    await app.request('/missing')

    expect(logEntries).toHaveLength(1)
    const entry = JSON.parse(logEntries[0])
    expect(entry.level).toBe('warn')
    expect(entry.status).toBe(404)
  })

  test('should log error level for 5xx responses', async () => {
    const app = new Hono()
    app.use('*', requestLoggingMiddleware())
    app.get('/fail', (c) => c.text('internal error', 500))

    await app.request('/fail')

    expect(logEntries).toHaveLength(1)
    const entry = JSON.parse(logEntries[0])
    expect(entry.level).toBe('error')
    expect(entry.status).toBe(500)
  })
})
