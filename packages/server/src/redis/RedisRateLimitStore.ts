import type { Redis } from 'ioredis'
import type { RateLimitStore, RateLimitEntry } from '../http/middleware/rate-limit'

/**
 * Options for RedisRateLimitStore.
 */
export interface RedisRateLimitStoreOptions {
  /**
   * Key prefix for rate limit keys.
   * @default 'ratelimit:'
   */
  prefix?: string
}

/**
 * Lua script for atomic increment with expiration.
 * Returns [count, resetAt] where resetAt is the timestamp when the window resets.
 */
const INCREMENT_SCRIPT = `
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
 * Redis-backed rate limit store using fixed window algorithm.
 * Uses Lua script for atomic increment operations.
 *
 * @example
 * ```ts
 * import { createRedisClient } from '@guren/server/redis'
 *
 * const redis = createRedisClient({ url: process.env.REDIS_URL })
 * const store = new RedisRateLimitStore(redis)
 *
 * app.use(createRateLimitMiddleware({ store, limit: 100 }))
 * ```
 */
export class RedisRateLimitStore implements RateLimitStore {
  private readonly prefix: string

  constructor(
    private readonly redis: Redis,
    options: RedisRateLimitStoreOptions = {}
  ) {
    this.prefix = options.prefix ?? 'ratelimit:'
  }

  /**
   * Get current rate limit entry for a key.
   */
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

  /**
   * Increment the rate limit counter atomically.
   */
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

  /**
   * Reset the rate limit for a key.
   */
  async reset(key: string): Promise<void> {
    const redisKey = this.prefix + key
    await this.redis.del(redisKey)
  }

  /**
   * Get all rate limit keys (for debugging/admin purposes).
   */
  async keys(): Promise<string[]> {
    const pattern = this.prefix + '*'
    const keys: string[] = []
    let cursor = '0'

    do {
      const [newCursor, foundKeys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = newCursor
      keys.push(...foundKeys)
    } while (cursor !== '0')

    return keys.map((key) => key.slice(this.prefix.length))
  }

  /**
   * Clear all rate limits.
   */
  async clear(): Promise<void> {
    const keys = await this.keys()
    if (keys.length > 0) {
      const prefixedKeys = keys.map((key) => this.prefix + key)
      await this.redis.del(...prefixedKeys)
    }
  }
}

/**
 * Redis-backed rate limit store using sliding window algorithm.
 * More accurate than fixed window but slightly more expensive.
 */
export class RedisSlidingWindowRateLimitStore implements RateLimitStore {
  private readonly prefix: string

  constructor(
    private readonly redis: Redis,
    options: RedisRateLimitStoreOptions = {}
  ) {
    this.prefix = options.prefix ?? 'ratelimit:sw:'
  }

  /**
   * Get current rate limit entry for a key.
   */
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

  /**
   * Increment the rate limit counter using sorted set.
   * Each request is stored with its timestamp as score.
   */
  async increment(key: string, windowMs: number): Promise<RateLimitEntry> {
    const redisKey = this.prefix + key
    const now = Date.now()
    const windowStart = now - windowMs

    // Use pipeline for atomic operations
    const pipeline = this.redis.pipeline()

    // Remove expired entries
    pipeline.zremrangebyscore(redisKey, '-inf', windowStart)
    // Add current request
    pipeline.zadd(redisKey, now, `${now}:${Math.random()}`)
    // Count entries in window
    pipeline.zcard(redisKey)
    // Set expiration
    pipeline.pexpire(redisKey, windowMs)

    const results = await pipeline.exec()

    // Get count from zcard result
    const count = (results?.[2]?.[1] as number) ?? 1

    return {
      count,
      resetAt: now + windowMs,
    }
  }

  /**
   * Reset the rate limit for a key.
   */
  async reset(key: string): Promise<void> {
    const redisKey = this.prefix + key
    await this.redis.del(redisKey)
  }

  /**
   * Clear all rate limits.
   */
  async clear(): Promise<void> {
    const pattern = this.prefix + '*'
    const keys: string[] = []
    let cursor = '0'

    do {
      const [newCursor, foundKeys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = newCursor
      keys.push(...foundKeys)
    } while (cursor !== '0')

    if (keys.length > 0) {
      await this.redis.del(...keys)
    }
  }
}
