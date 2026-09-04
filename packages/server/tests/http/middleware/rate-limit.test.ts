import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import {
  createRateLimitMiddleware,
  getRateLimitInfo,
  resetRateLimit,
  MemoryRateLimitStore,
  SlidingWindowRateLimitStore,
} from '../../../src/http/middleware/rate-limit'

// Far-future epoch (~2096): a store method that leaks Date.now() reads it as
// the past, so entries the tests expect to expire stay live and the test fails.
const FAKE_EPOCH = 4_000_000_000_000

describe('MemoryRateLimitStore', () => {
  let store: MemoryRateLimitStore
  let currentTime: number

  beforeEach(() => {
    currentTime = FAKE_EPOCH
    store = new MemoryRateLimitStore(0, () => currentTime) // Disable auto cleanup for tests
  })

  afterEach(() => {
    store.destroy()
  })

  it('returns null for non-existent keys', async () => {
    const entry = await store.get('non-existent')
    expect(entry).toBeNull()
  })

  it('increments and returns entry', async () => {
    const entry = await store.increment('key', 60000)

    expect(entry.count).toBe(1)
    expect(entry.resetAt).toBe(currentTime + 60000)
  })

  it('increments existing entry', async () => {
    await store.increment('key', 60000)
    await store.increment('key', 60000)
    const entry = await store.increment('key', 60000)

    expect(entry.count).toBe(3)
  })

  it('resets entry after window expires', async () => {
    await store.increment('key', 100) // 100ms window
    currentTime += 150

    const entry = await store.increment('key', 100)
    expect(entry.count).toBe(1)
  })

  it('returns null from get after window expires', async () => {
    await store.increment('key', 100) // 100ms window
    currentTime += 150

    expect(await store.get('key')).toBeNull()
  })

  it('resets a key', async () => {
    await store.increment('key', 60000)
    await store.reset('key')

    const entry = await store.get('key')
    expect(entry).toBeNull()
  })

  it('cleans up expired entries', async () => {
    await store.increment('expired', 1) // 1ms window
    await store.increment('valid', 60000) // 60s window
    currentTime += 10

    store.cleanup()

    expect(await store.get('expired')).toBeNull()
    expect(await store.get('valid')).not.toBeNull()
  })

  it('clears all entries', async () => {
    await store.increment('key1', 60000)
    await store.increment('key2', 60000)

    store.clear()

    expect(store.size).toBe(0)
  })

  it('reports correct size', async () => {
    expect(store.size).toBe(0)

    await store.increment('key1', 60000)
    expect(store.size).toBe(1)

    await store.increment('key2', 60000)
    expect(store.size).toBe(2)
  })
})

describe('SlidingWindowRateLimitStore', () => {
  let store: SlidingWindowRateLimitStore
  let currentTime: number

  beforeEach(() => {
    currentTime = FAKE_EPOCH
    store = new SlidingWindowRateLimitStore(0, () => currentTime)
  })

  afterEach(() => {
    store.destroy()
  })

  it('tracks requests in sliding window', async () => {
    await store.increment('key', 1000)
    await store.increment('key', 1000)
    const entry = await store.increment('key', 1000)

    expect(entry.count).toBe(3)
  })

  it('removes old requests from window', async () => {
    await store.increment('key', 100) // 100ms window
    currentTime += 150

    const entry = await store.increment('key', 100)
    expect(entry.count).toBe(1)
  })

  it('returns null when window has expired', async () => {
    await store.increment('key', 100) // 100ms window
    currentTime += 150

    const entry = await store.get('key')
    expect(entry).toBeNull()
  })

  it('resets a key', async () => {
    await store.increment('key', 60000)
    await store.reset('key')

    const entry = await store.get('key')
    expect(entry).toBeNull()
  })

  it('clears all entries', () => {
    store.clear()
    expect(store.size).toBe(0)
  })
})

describe('createRateLimitMiddleware', () => {
  let store: MemoryRateLimitStore
  let app: Hono
  let currentTime: number

  beforeEach(() => {
    currentTime = FAKE_EPOCH
    store = new MemoryRateLimitStore(0, () => currentTime)
    app = new Hono()
  })

  afterEach(() => {
    store.destroy()
  })

  it('allows requests under the limit', async () => {
    app.use('*', createRateLimitMiddleware({ limit: 5, store }))
    app.get('/', (c) => c.text('OK'))

    for (let i = 0; i < 5; i++) {
      const res = await app.request('/')
      expect(res.status).toBe(200)
    }
  })

  it('separates clients by proxy IP headers when trustProxy is enabled', async () => {
    app.use('*', createRateLimitMiddleware({ limit: 1, store, trustProxy: true }))
    app.get('/', (c) => c.text('OK'))

    const clientA1 = await app.request('/', { headers: { 'cf-connecting-ip': '1.1.1.1' } })
    const clientA2 = await app.request('/', { headers: { 'cf-connecting-ip': '1.1.1.1' } })
    const clientB1 = await app.request('/', { headers: { 'cf-connecting-ip': '2.2.2.2' } })

    expect(clientA1.status).toBe(200)
    expect(clientA2.status).toBe(429)
    expect(clientB1.status).toBe(200)
  })

  it('uses the first X-Forwarded-For entry when trustProxy is enabled', async () => {
    app.use('*', createRateLimitMiddleware({ limit: 1, store, trustProxy: true }))
    app.get('/', (c) => c.text('OK'))

    const first = await app.request('/', { headers: { 'x-forwarded-for': '3.3.3.3, 10.0.0.1' } })
    const second = await app.request('/', { headers: { 'x-forwarded-for': '3.3.3.3, 10.0.0.2' } })
    const other = await app.request('/', { headers: { 'x-forwarded-for': '4.4.4.4, 10.0.0.1' } })

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    expect(other.status).toBe(200)
  })

  it('ignores proxy headers by default (spoofing cannot bypass limits)', async () => {
    app.use('*', createRateLimitMiddleware({ limit: 1, store }))
    app.get('/', (c) => c.text('OK'))

    const first = await app.request('/', { headers: { 'x-forwarded-for': '5.5.5.5' } })
    const spoofed = await app.request('/', { headers: { 'x-forwarded-for': '6.6.6.6' } })

    expect(first.status).toBe(200)
    // Different spoofed header still hits the same shared fallback bucket
    expect(spoofed.status).toBe(429)
  })

  it('blocks requests over the limit', async () => {
    app.use('*', createRateLimitMiddleware({ limit: 3, store }))
    app.get('/', (c) => c.text('OK'))

    for (let i = 0; i < 3; i++) {
      await app.request('/')
    }

    const res = await app.request('/')
    expect(res.status).toBe(429)
  })

  it('returns correct rate limit headers', async () => {
    app.use('*', createRateLimitMiddleware({ limit: 10, store }))
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/')

    expect(res.headers.get('X-RateLimit-Limit')).toBe('10')
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('9')
    expect(res.headers.get('X-RateLimit-Reset')).toBe(
      Math.ceil((currentTime + 60000) / 1000).toString()
    )
  })

  it('returns Retry-After header when limited', async () => {
    app.use('*', createRateLimitMiddleware({ limit: 1, store, now: () => currentTime }))
    app.get('/', (c) => c.text('OK'))

    await app.request('/')
    const res = await app.request('/')

    expect(res.headers.get('Retry-After')).toBe('60')
  })

  it('skips requests when skip returns true', async () => {
    app.use(
      '*',
      createRateLimitMiddleware({
        limit: 1,
        store,
        skip: (ctx) => ctx.req.header('X-Skip') === 'true',
      })
    )
    app.get('/', (c) => c.text('OK'))

    await app.request('/')
    const res = await app.request('/', {
      headers: { 'X-Skip': 'true' },
    })

    expect(res.status).toBe(200)
  })

  it('uses custom key generator', async () => {
    app.use(
      '*',
      createRateLimitMiddleware({
        limit: 1,
        store,
        keyGenerator: (ctx) => ctx.req.header('X-API-Key') ?? 'anonymous',
      })
    )
    app.get('/', (c) => c.text('OK'))

    await app.request('/', { headers: { 'X-API-Key': 'user1' } })
    const res1 = await app.request('/', { headers: { 'X-API-Key': 'user1' } })
    expect(res1.status).toBe(429)

    const res2 = await app.request('/', { headers: { 'X-API-Key': 'user2' } })
    expect(res2.status).toBe(200)
  })

  it('uses custom error handler', async () => {
    app.use(
      '*',
      createRateLimitMiddleware({
        limit: 1,
        store,
        onRateLimited: (ctx, retryAfter) =>
          ctx.json({ custom: true, retryAfter }, { status: 503 }),
      })
    )
    app.get('/', (c) => c.text('OK'))

    await app.request('/')
    const res = await app.request('/')
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.custom).toBe(true)
  })

  it('uses custom message', async () => {
    app.use(
      '*',
      createRateLimitMiddleware({
        limit: 1,
        store,
        message: 'Slow down!',
      })
    )
    app.get('/', (c) => c.text('OK'))

    await app.request('/')
    const res = await app.request('/')
    const body = await res.json()

    expect(body.error).toBe('Slow down!')
  })

  it('uses custom status code', async () => {
    app.use(
      '*',
      createRateLimitMiddleware({
        limit: 1,
        store,
        statusCode: 503,
      })
    )
    app.get('/', (c) => c.text('OK'))

    await app.request('/')
    const res = await app.request('/')

    expect(res.status).toBe(503)
  })

  it('respects key prefix', async () => {
    app.use(
      '*',
      createRateLimitMiddleware({
        limit: 1,
        store,
        keyPrefix: 'api:',
      })
    )
    app.get('/', (c) => c.text('OK'))

    await app.request('/')
    const info = await getRateLimitInfo('__shared__:GET:/', store, { limit: 1, keyPrefix: 'api:' })

    expect(info.remaining).toBe(0)
  })

  it('disables headers when headers=false', async () => {
    app.use(
      '*',
      createRateLimitMiddleware({
        limit: 10,
        store,
        headers: false,
      })
    )
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/')

    expect(res.headers.get('X-RateLimit-Limit')).toBeNull()
    expect(res.headers.get('X-RateLimit-Remaining')).toBeNull()
  })

  it('resets limit after window expires', async () => {
    app.use(
      '*',
      createRateLimitMiddleware({
        limit: 1,
        windowMs: 100,
        store,
        now: () => currentTime,
      })
    )
    app.get('/', (c) => c.text('OK'))

    await app.request('/')
    let res = await app.request('/')
    expect(res.status).toBe(429)

    currentTime += 150

    res = await app.request('/')
    expect(res.status).toBe(200)
  })

  it('drives the default store with the injected clock', async () => {
    app.use('*', createRateLimitMiddleware({ limit: 1, windowMs: 100, now: () => currentTime }))
    app.get('/', (c) => c.text('OK'))

    await app.request('/')
    let res = await app.request('/')
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('1')

    currentTime += 150

    res = await app.request('/')
    expect(res.status).toBe(200)
  })

  it('clamps Retry-After at zero when the clock is past the window reset', async () => {
    app.use(
      '*',
      createRateLimitMiddleware({
        limit: 1,
        windowMs: 1000,
        store,
        now: () => currentTime + 5000,
      })
    )
    app.get('/', (c) => c.text('OK'))

    await app.request('/')
    const res = await app.request('/')

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('0')
  })
})

describe('getRateLimitInfo', () => {
  let store: MemoryRateLimitStore

  beforeEach(() => {
    store = new MemoryRateLimitStore(0)
  })

  afterEach(() => {
    store.destroy()
  })

  it('returns full limit for new keys', async () => {
    const info = await getRateLimitInfo('new-key', store, { limit: 100 })

    expect(info.limit).toBe(100)
    expect(info.remaining).toBe(100)
    expect(info.isLimited).toBe(false)
  })

  it('returns correct info for existing keys', async () => {
    await store.increment('rl:existing', 60000)
    await store.increment('rl:existing', 60000)

    const info = await getRateLimitInfo('existing', store, { limit: 5 })

    expect(info.limit).toBe(5)
    expect(info.remaining).toBe(3)
    expect(info.isLimited).toBe(false)
  })

  it('indicates when limited', async () => {
    for (let i = 0; i < 10; i++) {
      await store.increment('rl:limited', 60000)
    }

    const info = await getRateLimitInfo('limited', store, { limit: 5 })

    expect(info.isLimited).toBe(true)
    expect(info.remaining).toBe(0)
  })
})

describe('resetRateLimit', () => {
  let store: MemoryRateLimitStore

  beforeEach(() => {
    store = new MemoryRateLimitStore(0)
  })

  afterEach(() => {
    store.destroy()
  })

  it('resets rate limit for a key', async () => {
    await store.increment('rl:key', 60000)
    await store.increment('rl:key', 60000)

    await resetRateLimit('key', store)

    const info = await getRateLimitInfo('key', store, { limit: 100 })
    expect(info.remaining).toBe(100)
  })

  it('respects key prefix', async () => {
    await store.increment('api:key', 60000)

    await resetRateLimit('key', store, { keyPrefix: 'api:' })

    expect(await store.get('api:key')).toBeNull()
  })
})
