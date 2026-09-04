import type { MiddlewareHandler, Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { claimHotDisposable, isHotReloadRuntime, type HotDisposableClaim } from '../../hot-reload/hot-disposables'

/** Rate limit entry stored in the backing store. */
export interface RateLimitEntry {
  count: number
  resetAt: number
}

/** Store interface for rate limit data; implement for Redis or database-backed storage. */
export interface RateLimitStore {
  get(key: string): Promise<RateLimitEntry | null>

  /** Increments the count for a key, creating it with count=1 when absent. */
  increment(key: string, windowMs: number): Promise<RateLimitEntry>

  reset(key: string): Promise<void>
}

abstract class BaseMemoryStore implements RateLimitStore {
  protected cleanupInterval?: ReturnType<typeof setInterval>
  /**
   * Unlike the cache sweep, this interval is not `unref()`ed, so a leaked one
   * both duplicates work and keeps the process alive on its own.
   */
  private readonly hotReloadClaim: HotDisposableClaim | undefined

  constructor(
    cleanupIntervalMs = 60000,
    protected readonly now: () => number = () => Date.now(),
  ) {
    if (cleanupIntervalMs <= 0) {
      return
    }

    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs)

    // Subclasses declare no constructor, so a synthetic frame for the implicit
    // one sits between here and the caller; `describeCallerFile()` steps over it.
    this.hotReloadClaim = claimHotDisposable(
      'rate-limit-store',
      isHotReloadRuntime() ? new Error().stack : undefined,
      this.constructor.name,
      () => this.destroy(),
    )
  }

  abstract get(key: string): Promise<RateLimitEntry | null>
  abstract increment(key: string, windowMs: number): Promise<RateLimitEntry>
  abstract reset(key: string): Promise<void>
  abstract cleanup(): void
  abstract clear(): void
  abstract get size(): number

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = undefined
    }

    // Also the registry's teardown, where the slot already belongs to the
    // replacement and this release is a no-op.
    this.hotReloadClaim?.release()
  }
}

/** In-memory store: single-process development only, not production clusters. */
export class MemoryRateLimitStore extends BaseMemoryStore {
  private entries: Map<string, RateLimitEntry> = new Map()

  async get(key: string): Promise<RateLimitEntry | null> {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (this.now() >= entry.resetAt) {
      this.entries.delete(key)
      return null
    }
    return entry
  }

  async increment(key: string, windowMs: number): Promise<RateLimitEntry> {
    const now = this.now()
    const existing = this.entries.get(key)

    if (existing && now < existing.resetAt) {
      existing.count++
      return existing
    }

    const entry: RateLimitEntry = { count: 1, resetAt: now + windowMs }
    this.entries.set(key, entry)
    return entry
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key)
  }

  cleanup(): void {
    const now = this.now()
    for (const [key, entry] of this.entries.entries()) {
      if (now >= entry.resetAt) {
        this.entries.delete(key)
      }
    }
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

/** Configuration options for rate limiting. */
export interface RateLimitOptions {
  /** Maximum requests allowed in the window. @default 100 */
  limit?: number

  /** Time window in milliseconds. @default 60000 (1 minute) */
  windowMs?: number

  /** Defaults to the client IP address. */
  keyGenerator?: (ctx: Context) => string | Promise<string>

  /** Defaults to an in-memory store. */
  store?: RateLimitStore

  /** Skip rate limiting for certain requests. */
  skip?: (ctx: Context) => boolean | Promise<boolean>

  /** Custom handler when the rate limit is exceeded. */
  onRateLimited?: (ctx: Context, retryAfter: number) => Response | Promise<Response>

  /** Add rate limit headers to all responses. @default true */
  headers?: boolean

  /** @default 'Too many requests, please try again later.' */
  message?: string

  /** @default 429 */
  statusCode?: ContentfulStatusCode

  /** @default 'rl:' */
  keyPrefix?: string

  /**
   * Epoch-millisecond clock, injectable so tests advance time without sleeping.
   * Drives Retry-After and, when no `store` is supplied, the store created here;
   * a custom store keeps its own clock, so construct it with the same `now`.
   * @default () => Date.now()
   */
  now?: () => number

  /**
   * Trust reverse-proxy headers for client IP, in order: `CF-Connecting-IP`,
   * `True-Client-IP`, `X-Real-IP`, first entry of `X-Forwarded-For`; falls back
   * to `server.requestIP()`. Enable ONLY behind a proxy that sets or strips
   * them, or clients spoof them to bypass limits. Ignored with a custom `keyGenerator`.
   * @default false
   */
  trustProxy?: boolean
}

let defaultKeyGeneratorWarned = false

const PROXY_IP_HEADERS = ['cf-connecting-ip', 'true-client-ip', 'x-real-ip'] as const

function clientIpFromProxyHeaders(ctx: Context): string | null {
  for (const header of PROXY_IP_HEADERS) {
    const value = ctx.req.header(header)?.trim()
    if (value) return value
  }

  const forwardedFor = ctx.req.header('x-forwarded-for')
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim()
    if (first) return first
  }

  return null
}

function proxyAwareKeyGenerator(ctx: Context): string {
  return clientIpFromProxyHeaders(ctx) ?? defaultKeyGenerator(ctx)
}

/**
 * Per-client limiting via Bun's `server.requestIP()`. Where that is unavailable
 * (tests, non-Bun runtimes, Lambda) every client shares one per-route bucket:
 * over-restrictive but safe — production should supply a custom `keyGenerator`.
 * Proxy headers are not trusted by default; they are spoofable on direct deploys.
 */
function defaultKeyGenerator(ctx: Context): string {
  // Bun.serve passes { server } in env.
  const env = ctx.env as Record<string, unknown> | undefined
  if (env?.server && typeof (env.server as any).requestIP === 'function') {
    const info = (env.server as any).requestIP(ctx.req.raw)
    if (info?.address) return info.address as string
  }

  if (!defaultKeyGeneratorWarned) {
    defaultKeyGeneratorWarned = true
    console.warn(
      '[guren] Rate limiter: could not determine client IP via server.requestIP(). ' +
      'Falling back to shared per-route bucket (__shared__:METHOD:PATH). ' +
      'For per-client limiting, supply a custom keyGenerator option. ' +
      'See: https://guren.dev/docs/guides/rate-limiting',
    )
  }
  return `__shared__:${ctx.req.method}:${ctx.req.path}`
}

function defaultOnRateLimited(
  ctx: Context,
  retryAfter: number,
  message: string,
  statusCode: ContentfulStatusCode
): Response {
  return ctx.json(
    {
      error: message,
      retryAfter,
    },
    statusCode
  )
}

let defaultStore: MemoryRateLimitStore | null = null

function getDefaultStore(): MemoryRateLimitStore {
  if (!defaultStore) {
    defaultStore = new MemoryRateLimitStore()
  }
  return defaultStore
}

/**
 * Create a rate limiting middleware.
 * @example
 * ```ts
 * app.use('*', createRateLimitMiddleware({ limit: 100, windowMs: 60000 }))
 * ```
 */
export function createRateLimitMiddleware(options: RateLimitOptions = {}): MiddlewareHandler {
  const {
    limit = 100,
    windowMs = 60000,
    trustProxy = false,
    keyGenerator = trustProxy ? proxyAwareKeyGenerator : defaultKeyGenerator,
    // The shared default store runs on real time, so an injected clock needs a
    // dedicated store or expiry and Retry-After would disagree. No auto-cleanup:
    // a real-time sweep is meaningless on a fake clock and outlives the test.
    store = options.now ? new MemoryRateLimitStore(0, options.now) : getDefaultStore(),
    skip,
    onRateLimited,
    headers = true,
    message = 'Too many requests, please try again later.',
    statusCode = 429,
    keyPrefix = 'rl:',
    now = () => Date.now(),
  } = options

  return async (ctx, next) => {
    if (skip && (await skip(ctx))) {
      return next()
    }

    const baseKey = await keyGenerator(ctx)
    const key = `${keyPrefix}${baseKey}`

    const entry = await store.increment(key, windowMs)
    const remaining = Math.max(0, limit - entry.count)
    const resetSeconds = Math.max(0, Math.ceil((entry.resetAt - now()) / 1000))

    if (headers) {
      ctx.header('X-RateLimit-Limit', limit.toString())
      ctx.header('X-RateLimit-Remaining', remaining.toString())
      ctx.header('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000).toString())
    }

    if (entry.count > limit) {
      if (headers) {
        ctx.header('Retry-After', resetSeconds.toString())
      }

      if (onRateLimited) {
        return onRateLimited(ctx, resetSeconds)
      }

      return defaultOnRateLimited(ctx, resetSeconds, message, statusCode)
    }

    return next()
  }
}

/** Rate limit result information. */
export interface RateLimitInfo {
  limit: number
  remaining: number
  resetAt: Date
  isLimited: boolean
}

/** Get rate limit information for a key without incrementing. */
export async function getRateLimitInfo(
  key: string,
  store: RateLimitStore,
  options: { limit: number; keyPrefix?: string } = { limit: 100 }
): Promise<RateLimitInfo> {
  const { limit, keyPrefix = 'rl:' } = options
  const fullKey = `${keyPrefix}${key}`
  const entry = await store.get(fullKey)

  if (!entry) {
    return {
      limit,
      remaining: limit,
      resetAt: new Date(Date.now() + 60000),
      isLimited: false,
    }
  }

  const remaining = Math.max(0, limit - entry.count)

  return {
    limit,
    remaining,
    resetAt: new Date(entry.resetAt),
    isLimited: entry.count > limit,
  }
}

/** Reset the rate limit for a specific key. */
export async function resetRateLimit(
  key: string,
  store: RateLimitStore,
  options: { keyPrefix?: string } = {}
): Promise<void> {
  const { keyPrefix = 'rl:' } = options
  await store.reset(`${keyPrefix}${key}`)
}

/** More accurate than the fixed window store, at more memory. */
export class SlidingWindowRateLimitStore extends BaseMemoryStore {
  private requests: Map<string, { windowMs: number; timestamps: number[] }> = new Map()

  async get(key: string): Promise<RateLimitEntry | null> {
    const entry = this.requests.get(key)
    if (!entry || entry.timestamps.length === 0) return null

    const now = this.now()
    const windowStart = now - entry.windowMs
    const timestamps = entry.timestamps.filter((t) => t > windowStart)

    if (timestamps.length === 0) {
      this.requests.delete(key)
      return null
    }

    if (timestamps.length !== entry.timestamps.length) {
      this.requests.set(key, { windowMs: entry.windowMs, timestamps })
    }

    return { count: timestamps.length, resetAt: timestamps[0] + entry.windowMs }
  }

  async increment(key: string, windowMs: number): Promise<RateLimitEntry> {
    const now = this.now()
    const windowStart = now - windowMs
    const entry = this.requests.get(key)
    const timestamps = entry ? entry.timestamps.filter((t) => t > windowStart) : []
    timestamps.push(now)
    this.requests.set(key, { windowMs, timestamps })
    return { count: timestamps.length, resetAt: timestamps[0] + windowMs }
  }

  async reset(key: string): Promise<void> {
    this.requests.delete(key)
  }

  cleanup(): void {
    const now = this.now()
    for (const [key, entry] of this.requests.entries()) {
      const windowStart = now - entry.windowMs
      const valid = entry.timestamps.filter((t) => t > windowStart)
      if (valid.length === 0) {
        this.requests.delete(key)
      } else {
        this.requests.set(key, { windowMs: entry.windowMs, timestamps: valid })
      }
    }
  }

  clear(): void {
    this.requests.clear()
  }

  get size(): number {
    return this.requests.size
  }
}
