import type { Redis } from 'ioredis'
import type { RateLimitStore, RateLimitEntry } from '../http/middleware/rate-limit'
import { scanKeys } from './scan-keys'

export interface RedisRateLimitStoreOptions {
  /** @default 'ratelimit:' */
  prefix?: string
}

/**
 * Returns [count, resetAt]. Exported for the in-memory fake in tests, which
 * recognises the script by identity; not part of the public surface.
 */
export const INCREMENT_SCRIPT = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local now = tonumber(ARGV[2])

local count = redis.call('INCR', key)
if count == 1 then
  redis.call('PEXPIRE', key, window)
end
local ttl = redis.call('PTTL', key)
local resetAt = now + ttl
return {count, resetAt}
`

/**
 * Trim entries that fell out of the window, record this request, count what is
 * left, and refresh the expiry as one atomic step; returns the count. A pipeline
 * is not a substitute: Redis still interleaves other clients' commands between
 * its steps, so two concurrent callers could both ZADD before either ZCARD and
 * read the same count. The caller generates the member so the script stays deterministic.
 */
export const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local member = ARGV[3]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
redis.call('ZADD', key, now, member)
local count = redis.call('ZCARD', key)
redis.call('PEXPIRE', key, window)
return count
`

/** Fixed-window rate limiting; the Lua script keeps the increment atomic. */
export class RedisRateLimitStore implements RateLimitStore {
  private readonly prefix: string

  constructor(
    private readonly redis: Redis,
    options: RedisRateLimitStoreOptions = {}
  ) {
    this.prefix = options.prefix ?? 'ratelimit:'
  }

  async get(key: string): Promise<RateLimitEntry | null> {
    const redisKey = this.prefix + key
    const [countStr, ttl] = await Promise.all([
      this.redis.get(redisKey),
      this.redis.pttl(redisKey),
    ])

    if (!countStr || ttl <= 0) {
      return null
    }

    return {
      count: parseInt(countStr, 10),
      resetAt: Date.now() + ttl,
    }
  }

  async increment(key: string, windowMs: number): Promise<RateLimitEntry> {
    const redisKey = this.prefix + key
    const now = Date.now()

    const result = await this.redis.eval(
      INCREMENT_SCRIPT,
      1,
      redisKey,
      windowMs.toString(),
      now.toString()
    ) as [number, number]

    return {
      count: result[0],
      resetAt: result[1],
    }
  }

  async reset(key: string): Promise<void> {
    const redisKey = this.prefix + key
    await this.redis.del(redisKey)
  }

  /** Debugging/admin. */
  async keys(): Promise<string[]> {
    const keys = await scanKeys(this.redis, this.prefix + '*')
    return keys.map((key) => key.slice(this.prefix.length))
  }

  async clear(): Promise<void> {
    const keys = await this.keys()
    if (keys.length > 0) {
      const prefixedKeys = keys.map((key) => this.prefix + key)
      await this.redis.del(...prefixedKeys)
    }
  }
}

/**
 * Sliding window: more accurate than the fixed window, slightly more expensive.
 * The Lua script keeps trim, insert, and count atomic.
 */
export class RedisSlidingWindowRateLimitStore implements RateLimitStore {
  private readonly prefix: string

  constructor(
    private readonly redis: Redis,
    options: RedisRateLimitStoreOptions = {}
  ) {
    this.prefix = options.prefix ?? 'ratelimit:sw:'
  }

  async get(key: string): Promise<RateLimitEntry | null> {
    const redisKey = this.prefix + key
    const count = await this.redis.zcard(redisKey)

    if (count === 0) {
      return null
    }

    const ttl = await this.redis.pttl(redisKey)
    return {
      count,
      resetAt: ttl > 0 ? Date.now() + ttl : Date.now(),
    }
  }

  async increment(key: string, windowMs: number): Promise<RateLimitEntry> {
    const redisKey = this.prefix + key
    const now = Date.now()

    const count = await this.redis.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      redisKey,
      windowMs.toString(),
      now.toString(),
      `${now}:${Math.random()}`
    ) as number

    return {
      count,
      resetAt: now + windowMs,
    }
  }

  async reset(key: string): Promise<void> {
    const redisKey = this.prefix + key
    await this.redis.del(redisKey)
  }

  async clear(): Promise<void> {
    const keys = await scanKeys(this.redis, this.prefix + '*')
    if (keys.length > 0) {
      await this.redis.del(...keys)
    }
  }
}
