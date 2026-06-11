import type { MiddlewareHandler, Context } from 'hono'

/**
 * Rate limit entry stored in the backing store.
 */
export interface RateLimitEntry {
  count: number
  resetAt: number
}

/**
 * Store interface for rate limit data.
 * Implement this for Redis or database-backed storage.
 */
export interface RateLimitStore {
  /**
   * Get the current rate limit entry for a key.
   */
  get(key: string): Promise<RateLimitEntry | null>

  /**
   * Increment the count for a key and return the new entry.
   * If the key doesn't exist, create it with count=1.
   */
  increment(key: string, windowMs: number): Promise<RateLimitEntry>

  /**
   * Reset the count for a key.
   */
  reset(key: string): Promise<void>
}

/**
 * Base class for in-memory rate limit stores with automatic cleanup.
 */
abstract class BaseMemoryStore implements RateLimitStore {
  protected cleanupInterval?: ReturnType<typeof setInterval>

  constructor(cleanupIntervalMs = 60000) {
    if (cleanupIntervalMs > 0) {
      this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs)
    }
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
  }
}

/**
 * In-memory rate limit store.
 * Suitable for single-process development, not for production clusters.
 */
export class MemoryRateLimitStore extends BaseMemoryStore {
  private entries: Map<string, RateLimitEntry> = new Map()

  async get(key: string): Promise<RateLimitEntry | null> {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (Date.now() >= entry.resetAt) {
      this.entries.delete(key)
      return null
    }
    return entry
  }

  async increment(key: string, windowMs: number): Promise<RateLimitEntry> {
    const now = Date.now()
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
    const now = Date.now()
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

/**
 * Configuration options for rate limiting.
 */
export interface RateLimitOptions {
  /**
   * Maximum number of requests allowed in the time window.
   * @default 100
   */
  limit?: number

  /**
   * Time window in milliseconds.
   * @default 60000 (1 minute)
   */
  windowMs?: number

  /**
   * Function to extract the rate limit key from the request.
   * Defaults to using the client IP address.
   */
  keyGenerator?: (ctx: Context) => string | Promise<string>

  /**
   * Rate limit store implementation.
   * Defaults to in-memory store.
   */
  store?: RateLimitStore

  /**
   * Whether to skip rate limiting for certain requests.
   */
  skip?: (ctx: Context) => boolean | Promise<boolean>

  /**
   * Custom handler when rate limit is exceeded.
   */
  onRateLimited?: (ctx: Context, retryAfter: number) => Response | Promise<Response>

  /**
   * Whether to add rate limit headers to all responses.
   * @default true
   */
  headers?: boolean

  /**
   * Custom message when rate limit is exceeded.
   * @default 'Too many requests, please try again later.'
   */
  message?: string

  /**
   * HTTP status code when rate limit is exceeded.
   * @default 429
   */
  statusCode?: number

  /**
   * Prefix for rate limit keys.
   * @default 'rl:'
   */
  keyPrefix?: string

  /**
   * Trust reverse-proxy headers for client IP resolution, checked in order:
   * `CF-Connecting-IP`, `True-Client-IP`, `X-Real-IP`, then the first entry
   * of `X-Forwarded-For`. Falls back to `server.requestIP()` when none are set.
   *
   * Enable ONLY when every request passes through a proxy that sets or strips
   * these headers — on direct deployments clients can spoof them to bypass
   * per-client limits. Ignored when a custom `keyGenerator` is supplied.
   * @default false
   */
  trustProxy?: boolean
}

let defaultKeyGeneratorWarned = false

/**
 * Default key generator using Bun's `server.requestIP()` for per-client limiting.
 *
 * **Important:** When `server.requestIP()` is unavailable (tests, non-Bun runtimes,
 * Lambda), this falls back to a shared per-route bucket (`__shared__:METHOD:PATH`).
 * In that mode, all clients hitting the same endpoint share a single rate-limit
 * counter, which is overly restrictive but safe.
 *
 * **For production deployments, always supply a custom `keyGenerator`:**
 *
 * ```ts
 * createRateLimitMiddleware({
 *   keyGenerator: (c) => c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? 'unknown',
 * })
 * ```
 *
 * Does NOT trust proxy headers by default to prevent rate-limit bypass via
 * header spoofing on direct deployments.
 */
const PROXY_IP_HEADERS = ['cf-connecting-ip', 'true-client-ip', 'x-real-ip'] as const

/**
 * Resolve the client IP from trusted reverse-proxy headers.
 * Returns null when no proxy header is present.
 */
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

function defaultKeyGenerator(ctx: Context): string {
  // Bun.serve passes { server } in env — use server.requestIP() for true client IP
  const env = ctx.env as Record<string, unknown> | undefined
  if (env?.server && typeof (env.server as any).requestIP === 'function') {
    const info = (env.server as any).requestIP(ctx.req.raw)
    if (info?.address) return info.address as string
  }

  // Fallback: shared per-route bucket. The __shared__ prefix makes it explicit
  // that this is an incomplete fallback, not per-client limiting.
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

/**
 * Default rate limit exceeded handler.
 */
function defaultOnRateLimited(
  ctx: Context,
  retryAfter: number,
  message: string,
  statusCode: number
): Response {
  return ctx.json(
    {
      error: message,
      retryAfter,
    },
    statusCode as 429
  )
}

// Shared default store instance
let defaultStore: MemoryRateLimitStore | null = null

function getDefaultStore(): MemoryRateLimitStore {
  if (!defaultStore) {
    defaultStore = new MemoryRateLimitStore()
  }
  return defaultStore
}

/**
 * Create a rate limiting middleware.
 *
 * @example
 * ```ts
 * // Basic usage - 100 requests per minute per IP
 * app.use('*', createRateLimitMiddleware())
 *
 * // Stricter limit for login endpoint
 * router.post('/login', [AuthController, 'login'],
 *   createRateLimitMiddleware({
 *     limit: 5,
 *     windowMs: 15 * 60 * 1000, // 15 minutes
 *   })
 * )
 *
 * // Custom key based on authenticated user
 * app.use('/api/*', createRateLimitMiddleware({
 *   limit: 1000,
 *   windowMs: 60 * 60 * 1000, // 1 hour
 *   keyGenerator: async (ctx) => {
 *     const user = await ctx.get('user')
 *     return user?.id?.toString() ?? defaultKeyGenerator(ctx)
 *   },
 * }))
 * ```
 */
export function createRateLimitMiddleware(options: RateLimitOptions = {}): MiddlewareHandler {
  const {
    limit = 100,
    windowMs = 60000,
    trustProxy = false,
    keyGenerator = trustProxy ? proxyAwareKeyGenerator : defaultKeyGenerator,
    store = getDefaultStore(),
    skip,
    onRateLimited,
    headers = true,
    message = 'Too many requests, please try again later.',
    statusCode = 429,
    keyPrefix = 'rl:',
  } = options

  return async (ctx, next) => {
    // Check if we should skip this request
    if (skip && (await skip(ctx))) {
      return next()
    }

    // Generate the rate limit key
    const baseKey = await keyGenerator(ctx)
    const key = `${keyPrefix}${baseKey}`

    // Get or create rate limit entry
    const entry = await store.increment(key, windowMs)
    const remaining = Math.max(0, limit - entry.count)
    const resetSeconds = Math.ceil((entry.resetAt - Date.now()) / 1000)

    // Add rate limit headers
    if (headers) {
      ctx.header('X-RateLimit-Limit', limit.toString())
      ctx.header('X-RateLimit-Remaining', remaining.toString())
      ctx.header('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000).toString())
    }

    // Check if rate limit exceeded
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

/**
 * Rate limit result information.
 */
export interface RateLimitInfo {
  limit: number
  remaining: number
  resetAt: Date
  isLimited: boolean
}

/**
 * Get rate limit information for a key without incrementing.
 *
 * @example
 * ```ts
 * const info = await getRateLimitInfo('user:123', store, { limit: 100 })
 * console.log(`${info.remaining} requests remaining`)
 * ```
 */
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

/**
 * Reset rate limit for a specific key.
 *
 * @example
 * ```ts
 * // Reset rate limit after successful captcha
 * await resetRateLimit(clientIp, store)
 * ```
 */
export async function resetRateLimit(
  key: string,
  store: RateLimitStore,
  options: { keyPrefix?: string } = {}
): Promise<void> {
  const { keyPrefix = 'rl:' } = options
  await store.reset(`${keyPrefix}${key}`)
}

/**
 * Sliding window rate limit store.
 * More accurate than fixed window but uses more memory.
 */
export class SlidingWindowRateLimitStore extends BaseMemoryStore {
  private requests: Map<string, { windowMs: number; timestamps: number[] }> = new Map()

  async get(key: string): Promise<RateLimitEntry | null> {
    const entry = this.requests.get(key)
    if (!entry || entry.timestamps.length === 0) return null

    const now = Date.now()
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
    const now = Date.now()
    const windowStart = now - windowMs
    const entry = this.requests.get(key)
    let timestamps = entry ? entry.timestamps.filter((t) => t > windowStart) : []
    timestamps.push(now)
    this.requests.set(key, { windowMs, timestamps })
    return { count: timestamps.length, resetAt: timestamps[0] + windowMs }
  }

  async reset(key: string): Promise<void> {
    this.requests.delete(key)
  }

  cleanup(): void {
    const now = Date.now()
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
