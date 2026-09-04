# Rate Limiting Guide

Guren provides a flexible rate limiting system to protect your application from abuse. It supports multiple storage backends, custom key generators, and both fixed and sliding window algorithms.

## Core Concepts

- **RateLimitStore** – Interface for storing rate limit data.
- **MemoryRateLimitStore** – In-memory store for single-process applications.
- **SlidingWindowRateLimitStore** – More accurate sliding window implementation.
- **Rate Limit Headers** – Standard headers for client feedback.

## Basic Usage

### Quick Start

```ts
import { Router, createRateLimitMiddleware } from '@guren/core'

// Apply to all routes - 100 requests per minute per IP
const router = new Router()

router.middleware(createRateLimitMiddleware()).group((group) => {
  group.get('/api/*', [ApiController, 'handle'])
})
```

### Route-Specific Limits

```ts
import { Router, createRateLimitMiddleware } from '@guren/core'

const router = new Router()

// Stricter limit for login endpoint - 5 attempts per 15 minutes
router.post('/login', [AuthController, 'login']).middleware(
  createRateLimitMiddleware({
    limit: 5,
    windowMs: 15 * 60 * 1000, // 15 minutes
  })
)

// Higher limit for authenticated API routes
router.middleware('auth').group((group) => {
  group.get('/api/*', [ApiController, 'handle']).middleware(
    createRateLimitMiddleware({
      limit: 1000,
      windowMs: 60 * 60 * 1000, // 1 hour
    })
  )
})
```

## Configuration Options

```ts
interface RateLimitOptions {
  /** Maximum requests in the time window (default: 100) */
  limit?: number

  /** Time window in milliseconds (default: 60000 = 1 minute) */
  windowMs?: number

  /** Function to extract rate limit key from request */
  keyGenerator?: (ctx: Context) => string | Promise<string>

  /** Rate limit store implementation */
  store?: RateLimitStore

  /** Skip rate limiting for certain requests */
  skip?: (ctx: Context) => boolean | Promise<boolean>

  /** Custom handler when rate limit exceeded */
  onRateLimited?: (ctx: Context, retryAfter: number) => Response | Promise<Response>

  /** Add rate limit headers to responses (default: true) */
  headers?: boolean

  /** Error message when limited (default: 'Too many requests...') */
  message?: string

  /** HTTP status code when limited (default: 429). Hono's `ContentfulStatusCode`, re-exported from `@guren/core`. */
  statusCode?: ContentfulStatusCode

  /** Prefix for rate limit keys (default: 'rl:') */
  keyPrefix?: string

  /** Trust proxy headers (CF-Connecting-IP, True-Client-IP, X-Real-IP, X-Forwarded-For) for client IPs (default: false) */
  trustProxy?: boolean
}
```

### Deployments Behind a Proxy

When your app always sits behind a reverse proxy or CDN (Cloudflare, ALB, Nginx), enable `trustProxy` for per-client limiting without writing a custom `keyGenerator`:

```ts
createRateLimitMiddleware({
  limit: 100,
  trustProxy: true, // resolves CF-Connecting-IP → True-Client-IP → X-Real-IP → X-Forwarded-For[0]
})
```

> **Warning:** Enable `trustProxy` only when every request passes through your proxy. On direct deployments clients can spoof these headers to bypass per-client limits — that is why it defaults to `false`.

### Full Configuration Example

```ts
import { createRateLimitMiddleware, MemoryRateLimitStore } from '@guren/core'

const store = new MemoryRateLimitStore()

const rateLimiter = createRateLimitMiddleware({
  limit: 100,
  windowMs: 60 * 1000,          // 1 minute
  store,
  keyPrefix: 'api:',
  headers: true,
  message: 'Rate limit exceeded. Please slow down.',
  statusCode: 429,

  // Key based on authenticated user or IP
  keyGenerator: async (ctx) => {
    const user = ctx.get('user')
    if (user?.id) {
      return `user:${user.id}`
    }
    return ctx.req.header('x-forwarded-for')?.split(',')[0] ?? 'unknown'
  },

  // Skip for admin users
  skip: async (ctx) => {
    const user = ctx.get('user')
    return user?.role === 'admin'
  },

  // Custom response
  onRateLimited: (ctx, retryAfter) => {
    return ctx.json({
      error: 'Too many requests',
      retryAfter,
      documentation: 'https://api.example.com/docs/rate-limits',
    }, 429)
  },
})
```

## Rate Limit Headers

When `headers: true` (default), the following headers are added to all responses:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests allowed in the window |
| `X-RateLimit-Remaining` | Remaining requests in current window |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |
| `Retry-After` | Seconds until retry (only when limited) |

### Example Response Headers

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1705312800
```

## Storage Backends

### Memory Store

Suitable for single-process applications:

```ts
import { MemoryRateLimitStore } from '@guren/core'

const store = new MemoryRateLimitStore(60000) // Cleanup every 60 seconds

const rateLimiter = createRateLimitMiddleware({
  limit: 100,
  store,
})

// Cleanup on shutdown
process.on('SIGTERM', () => {
  store.destroy()
})
```

### Sliding Window Store

More accurate rate limiting that smooths out traffic:

```ts
import { SlidingWindowRateLimitStore } from '@guren/core'

const store = new SlidingWindowRateLimitStore()

const rateLimiter = createRateLimitMiddleware({
  limit: 100,
  windowMs: 60 * 1000,
  store,
})
```

**Fixed Window vs Sliding Window:**
- **Fixed Window**: Resets counter at window boundaries. Allows burst at boundary edges.
- **Sliding Window**: Tracks each request timestamp. Provides smoother rate limiting.

### Redis Store (Distributed)

For distributed applications, use the Redis-backed stores that ship with the framework:

```ts
import { createRateLimitMiddleware } from '@guren/core'
import { createRedisClient, RedisRateLimitStore, RedisSlidingWindowRateLimitStore } from '@guren/core/redis'

const redis = createRedisClient({ url: process.env.REDIS_URL })

const limiter = createRateLimitMiddleware({
  max: 60,
  windowMs: 60_000,
  store: new RedisRateLimitStore(redis),
})

// Sliding-window variant for smoother limiting
const sliding = createRateLimitMiddleware({
  max: 60,
  windowMs: 60_000,
  store: new RedisSlidingWindowRateLimitStore(redis),
})
```

> [!NOTE]
> Need custom semantics? Implement the `RateLimitStore` interface from `@guren/core` — any object with `get`, `increment`, and `reset` works as a store.

## Helper Functions

### Get Rate Limit Info

Check rate limit status without incrementing:

```ts
import { getRateLimitInfo, MemoryRateLimitStore } from '@guren/core'

const store = new MemoryRateLimitStore()

// Check user's rate limit status
const info = await getRateLimitInfo('user:123', store, { limit: 100 })

console.log(`${info.remaining} requests remaining`)
console.log(`Resets at ${info.resetAt}`)
console.log(`Is limited: ${info.isLimited}`)
```

### Reset Rate Limit

Clear rate limit for a specific key:

```ts
import { resetRateLimit, MemoryRateLimitStore } from '@guren/core'

const store = new MemoryRateLimitStore()

// Reset after successful captcha verification
await resetRateLimit('user:123', store)

// With custom key prefix
await resetRateLimit('192.168.1.1', store, { keyPrefix: 'login:' })
```

## Common Patterns

### Different Limits by Endpoint

```ts
import { Router } from '@guren/core'

// Strict limit for authentication
const authLimiter = createRateLimitMiddleware({
  limit: 5,
  windowMs: 15 * 60 * 1000, // 15 minutes
  keyPrefix: 'auth:',
})

// Standard API limit
const apiLimiter = createRateLimitMiddleware({
  limit: 100,
  windowMs: 60 * 1000, // 1 minute
  keyPrefix: 'api:',
})

// Higher limit for search (expensive operation)
const searchLimiter = createRateLimitMiddleware({
  limit: 20,
  windowMs: 60 * 1000,
  keyPrefix: 'search:',
})

// Apply to routes
const router = new Router()

router.post('/login', [AuthController, 'login']).middleware(authLimiter)
router.post('/register', [AuthController, 'register']).middleware(authLimiter)
router.get('/api/*', [ApiController, 'handle']).middleware(apiLimiter)
router.get('/search', [SearchController, 'search']).middleware(searchLimiter)
```

### User-Based Rate Limiting

```ts
const userRateLimiter = createRateLimitMiddleware({
  limit: 1000,
  windowMs: 60 * 60 * 1000, // 1 hour

  keyGenerator: async (ctx) => {
    const user = ctx.get('user')
    if (!user) {
      // Fall back to IP for unauthenticated requests
      return `ip:${ctx.req.header('x-forwarded-for') ?? 'unknown'}`
    }

    // Different limits per plan
    const limitMultiplier = user.plan === 'premium' ? 10 : 1
    return `user:${user.id}:${limitMultiplier}`
  },
})
```

### Skip Trusted Sources

```ts
const rateLimiter = createRateLimitMiddleware({
  limit: 100,
  skip: (ctx) => {
    // Skip for internal services
    const apiKey = ctx.req.header('x-api-key')
    return apiKey === process.env.INTERNAL_API_KEY

    // Or skip for certain IPs
    const ip = ctx.req.header('x-forwarded-for')
    return ['10.0.0.1', '10.0.0.2'].includes(ip ?? '')
  },
})
```

### Custom Error Response

```ts
const rateLimiter = createRateLimitMiddleware({
  limit: 100,
  onRateLimited: (ctx, retryAfter) => {
    // Log the rate limit hit
    console.warn(`Rate limit hit for ${ctx.req.path}`)

    // Return custom response
    return ctx.json({
      status: 'error',
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'You have exceeded the rate limit.',
      retryAfter,
      upgrade: 'https://example.com/pricing',
    }, 429)
  },
})
```

## Testing

```ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import {
  createRateLimitMiddleware,
  MemoryRateLimitStore,
  getRateLimitInfo,
  resetRateLimit,
} from '@guren/core'

describe('Rate Limiting', () => {
  let store: MemoryRateLimitStore
  let app: Hono

  beforeEach(() => {
    store = new MemoryRateLimitStore(0) // Disable auto cleanup
    app = new Hono()
  })

  afterEach(() => {
    store.destroy()
  })

  test('allows requests under the limit', async () => {
    app.use('*', createRateLimitMiddleware({ limit: 5, store }))
    app.get('/', (c) => c.text('OK'))

    for (let i = 0; i < 5; i++) {
      const res = await app.request('/')
      expect(res.status).toBe(200)
    }
  })

  test('blocks requests over the limit', async () => {
    app.use('*', createRateLimitMiddleware({ limit: 3, store }))
    app.get('/', (c) => c.text('OK'))

    // Use up the limit
    for (let i = 0; i < 3; i++) {
      await app.request('/')
    }

    // Next request should be blocked
    const res = await app.request('/')
    expect(res.status).toBe(429)
  })

  test('returns rate limit headers', async () => {
    app.use('*', createRateLimitMiddleware({ limit: 10, store }))
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/')

    expect(res.headers.get('X-RateLimit-Limit')).toBe('10')
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('9')
    expect(res.headers.get('X-RateLimit-Reset')).toBeDefined()
  })

  test('uses custom key generator', async () => {
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

  test('resets limit after window expires', async () => {
    app.use(
      '*',
      createRateLimitMiddleware({
        limit: 1,
        windowMs: 100, // 100ms window
        store,
      })
    )
    app.get('/', (c) => c.text('OK'))

    await app.request('/')
    let res = await app.request('/')
    expect(res.status).toBe(429)

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 150))

    res = await app.request('/')
    expect(res.status).toBe(200)
  })
})
```

## Best Practices

1. **Use appropriate windows**: Short windows (1 min) for general API, longer (15-60 min) for auth.

2. **Different limits per endpoint**: Apply stricter limits to expensive or sensitive operations.

3. **Key by user when possible**: Authenticated user keys prevent one user from affecting others.

4. **Always include headers**: Help clients implement proper backoff strategies.

5. **Use Redis in production**: Memory stores don't work with multiple server instances.

6. **Log rate limit hits**: Monitor for abuse patterns and adjust limits accordingly.

7. **Provide upgrade path**: Let users know how to get higher limits (e.g., premium plan).

8. **Clean up stores**: Call `destroy()` on memory stores when shutting down.
