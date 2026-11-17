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
  /** A sweep leaked across a hot reload would run beside this one. */
  private readonly hotReloadClaim: HotDisposableClaim | undefined

  constructor(
    cleanupIntervalMs = 60000,
    protected readonly now: () => number = () => Date.now(),
  ) {
    if (cleanupIntervalMs <= 0) {
      return
    }

    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs)
    // A sweep must not keep alive a process that merely evaluated a routes
    // module (a CLI command, a test). Workers may return a number: hence the `?.`.
    this.cleanupInterval.unref?.()

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
    return { ...entry }
  }

  async increment(key: string, windowMs: number): Promise<RateLimitEntry> {
    const now = this.now()
    const existing = this.entries.get(key)

    if (existing && now < existing.resetAt) {
      existing.count++
      return { ...existing }
    }

    const entry: RateLimitEntry = { count: 1, resetAt: now + windowMs }
    this.entries.set(key, entry)
    return { ...entry }
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
   * Read the client IP from what a reverse proxy adds rather than from `server.requestIP()`.
   * `true` is `{ hops: 1 }`. Enable ONLY when every request passes through that proxy, or
   * clients send the header themselves to bypass limits. Ignored with a custom `keyGenerator`.
   * @default false
   */
  trustProxy?: TrustProxy
}

/**
 * Which proxy-added value names the client. `{ hops: n }` is the `n`th `X-Forwarded-For` entry
 * from the right: proxies append, so only the entries your own `n` proxies wrote are theirs.
 * `{ header }` is one single-value header your proxy overwrites, such as `cf-connecting-ip`.
 * A port on the value (`203.0.113.7:50001`, `[2001:db8::7]:50001`) is dropped. Absent, or with
 * fewer entries than hops, the socket address is used.
 */
export type TrustProxy = boolean | { hops: number } | { header: string }

let defaultKeyGeneratorWarned = false

type ProxySource = { hops: number } | { header: string }

// A proxy passes these on as the client sent them, so `{ hops }` never reads them; seeing one warns once.
const UNREAD_PROXY_HEADERS = ['cf-connecting-ip', 'true-client-ip', 'x-real-ip'] as const

let unreadProxyHeaderWarned = false

// RFC 9110 §5.6.2 `token`; `Headers.get()` throws on any other name, on every request.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/

function proxySource(trustProxy: TrustProxy): ProxySource | undefined {
  if (trustProxy === false) return undefined
  if (trustProxy === true) return { hops: 1 }
  if ('hops' in trustProxy) {
    if (!Number.isInteger(trustProxy.hops) || trustProxy.hops < 1) {
      throw new TypeError(`trustProxy.hops must be a positive integer, got ${String(trustProxy.hops)}.`)
    }
    return { hops: trustProxy.hops }
  }
  const header = typeof trustProxy.header === 'string' ? trustProxy.header.trim().toLowerCase() : ''
  if (header === '') throw new TypeError('trustProxy.header must name a request header.')
  if (!HEADER_NAME.test(header)) {
    throw new TypeError(`trustProxy.header must be a valid header name, got ${JSON.stringify(trustProxy.header)}.`)
  }
  if (header === 'x-forwarded-for') {
    throw new TypeError('trustProxy.header cannot be x-forwarded-for, a list clients add to; use trustProxy: { hops } for it.')
  }
  return { header }
}

// A load balancer that preserves the client port appends `ip:port`, and a port per connection
// would give each connection its own bucket. Bare IPv6 has more than one colon and stays whole.
function withoutPort(address: string): string {
  if (address.startsWith('[')) {
    const close = address.indexOf(']')
    return close > 1 ? address.slice(1, close) : address
  }
  const colon = address.indexOf(':')
  return colon > 0 && colon === address.lastIndexOf(':') ? address.slice(0, colon) : address
}

function proxyClientIp(ctx: Context, source: ProxySource): string | undefined {
  const address = proxyValue(ctx, source)
  return address ? withoutPort(address) || undefined : undefined
}

function proxyValue(ctx: Context, source: ProxySource): string | undefined {
  if ('header' in source) return ctx.req.header(source.header)?.trim() || undefined

  if (!unreadProxyHeaderWarned && UNREAD_PROXY_HEADERS.some((name) => ctx.req.header(name) !== undefined)) {
    unreadProxyHeaderWarned = true
    console.warn(
      '[guren] Rate limiter: trustProxy keys on the X-Forwarded-For entries your proxies append and does not read ' +
      'CF-Connecting-IP, True-Client-IP or X-Real-IP, which a client can send. If your proxy overwrites one of them, ' +
      "pass trustProxy: { header: 'cf-connecting-ip' }; behind two proxies, trustProxy: { hops: 2 }. " +
      'See: https://guren.dev/docs/guides/rate-limiting',
    )
  }

  const entries = (ctx.req.header('x-forwarded-for') ?? '').split(',').map((entry) => entry.trim())
  if (entries.length < source.hops) return undefined
  return entries[entries.length - source.hops] || undefined
}

function socketAddress(ctx: Context): string | undefined {
  // Bun.serve passes { server } in env.
  const env = ctx.env as Record<string, unknown> | undefined
  if (env?.server && typeof (env.server as any).requestIP === 'function') {
    const info = (env.server as any).requestIP(ctx.req.raw)
    if (info?.address) return info.address as string
  }
  return undefined
}

/**
 * The client IP a rate limiter keys on: the proxy-added value `trustProxy` names, else
 * `server.requestIP()`, else `undefined` (tests, non-Bun runtimes, Lambda). For a custom
 * `keyGenerator` that should read the same address the built-in one does.
 */
export function resolveClientIp(ctx: Context, trustProxy?: TrustProxy): string | undefined {
  const source = proxySource(trustProxy ?? false)
  return (source ? proxyClientIp(ctx, source) : undefined) ?? socketAddress(ctx)
}

/**
 * Per-client limiting via Bun's `server.requestIP()`. Where that is unavailable
 * (tests, non-Bun runtimes, Lambda) every client shares one per-route bucket:
 * over-restrictive but safe — production should supply a custom `keyGenerator`.
 * Proxy headers are not trusted by default; they are spoofable on direct deploys.
 */
function defaultKeyGenerator(ctx: Context, source?: ProxySource): string {
  const address = (source ? proxyClientIp(ctx, source) : undefined) ?? socketAddress(ctx)
  if (address) return address

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

function keyGeneratorFor(source: ProxySource | undefined): (ctx: Context) => string {
  return source ? (ctx) => defaultKeyGenerator(ctx, source) : (ctx) => defaultKeyGenerator(ctx)
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
    keyGenerator = keyGeneratorFor(proxySource(trustProxy)),
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
