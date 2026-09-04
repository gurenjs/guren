import type { Redis } from 'ioredis'
import type { RateLimitStore, RateLimitEntry } from '../http/middleware/rate-limit'
import { scanKeys } from './scan-keys'

export interface RedisRateLimitStoreOptions {
  /** @default 'ratelimit:' */
  prefix?: string
}

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

/** Sliding window: more accurate than the fixed window, slightly more expensive. */
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
    const windowStart = now - windowMs

    const pipeline = this.redis.pipeline()

    pipeline.zremrangebyscore(redisKey, '-inf', windowStart)
    pipeline.zadd(redisKey, now, `${now}:${Math.random()}`)
    pipeline.zcard(redisKey)
    pipeline.pexpire(redisKey, windowMs)

    const results = await pipeline.exec()

    // Get count from zcard result
    const count = (results?.[2]?.[1] as number) ?? 1

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
