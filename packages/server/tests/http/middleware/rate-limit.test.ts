import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import {
  createRateLimitMiddleware,
  getRateLimitInfo,
  resetRateLimit,
  MemoryRateLimitStore,
  SlidingWindowRateLimitStore,
} from '../../../src/http/middleware/rate-limit'

describe('MemoryRateLimitStore', () => {
  let store: MemoryRateLimitStore

  beforeEach(() => {
    store = new MemoryRateLimitStore(0) // Disable auto cleanup for tests
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
    expect(entry.resetAt).toBeGreaterThan(Date.now())
  })

  it('increments existing entry', async () => {
    await store.increment('key', 60000)
    await store.increment('key', 60000)
    const entry = await store.increment('key', 60000)

    expect(entry.count).toBe(3)
  })

  it('resets entry after window expires', async () => {
    await store.increment('key', 100) // 100ms window
    await new Promise((r) => setTimeout(r, 150))

    const entry = await store.increment('key', 100)
    expect(entry.count).toBe(1) // Reset to 1
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
    await new Promise((r) => setTimeout(r, 10))

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

  beforeEach(() => {
    store = new SlidingWindowRateLimitStore(0)
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
    await new Promise((r) => setTimeout(r, 150))

    const entry = await store.increment('key', 100)
    expect(entry.count).toBe(1) // Old request removed
  })

  it('returns null when window has expired', async () => {
    await store.increment('key', 100) // 100ms window
    await new Promise((r) => setTimeout(r, 150))

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

  beforeEach(() => {
    store = new MemoryRateLimitStore(0)
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
    expect(res.headers.get('X-RateLimit-Reset')).toBeDefined()
  })

  it('returns Retry-After header when limited', async () => {
    app.use('*', createRateLimitMiddleware({ limit: 1, store }))
    app.get('/', (c) => c.text('OK'))

    await app.request('/')
    const res = await app.request('/')

    expect(res.headers.get('Retry-After')).toBeDefined()
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

    // First user hits limit
    await app.request('/', { headers: { 'X-API-Key': 'user1' } })
    const res1 = await app.request('/', { headers: { 'X-API-Key': 'user1' } })
    expect(res1.status).toBe(429)

    // Second user can still request
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
    const info = await getRateLimitInfo('unknown', store, { limit: 1, keyPrefix: 'api:' })

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
      })
    )
    app.get('/', (c) => c.text('OK'))

    await app.request('/')
    let res = await app.request('/')
    expect(res.status).toBe(429)

    await new Promise((r) => setTimeout(r, 150))

    res = await app.request('/')
    expect(res.status).toBe(200)
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
