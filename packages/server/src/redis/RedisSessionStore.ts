import type { Redis } from 'ioredis'
import type { SessionStore, SessionData } from '../http/middleware/session'
import { scanKeys } from './scan-keys'

/**
 * Options for RedisSessionStore.
 */
export interface RedisSessionStoreOptions {
  /**
   * Key prefix for session keys.
   * @default 'session:'
   */
  prefix?: string
}

/**
 * Redis-backed session store.
 *
 * @example
 * ```ts
 * import { createRedisClient } from '@guren/server/redis'
 *
 * const redis = createRedisClient({ url: process.env.REDIS_URL })
 * const store = new RedisSessionStore(redis)
 *
 * app.use(createSessionMiddleware({ store }))
 * ```
 */
export class RedisSessionStore implements SessionStore {
  private readonly prefix: string

  constructor(
    private readonly redis: Redis,
    options: RedisSessionStoreOptions = {}
  ) {
    this.prefix = options.prefix ?? 'session:'
  }

  /**
   * Read session data from Redis.
   */
  async read(id: string): Promise<SessionData | undefined> {
    const key = this.prefix + id
    const data = await this.redis.get(key)

    if (!data) {
      return undefined
    }

    try {
      return JSON.parse(data) as SessionData
    } catch {
      return undefined
    }
  }

  /**
   * Write session data to Redis with TTL.
   */
  async write(id: string, data: SessionData, ttlSeconds: number): Promise<void> {
    const key = this.prefix + id
    const serialized = JSON.stringify(data)
    await this.redis.setex(key, ttlSeconds, serialized)
  }

  /**
   * Delete a session from Redis.
   */
  async destroy(id: string): Promise<void> {
    const key = this.prefix + id
    await this.redis.del(key)
  }

  /**
   * Refresh an existing session's TTL without rewriting its data.
   * EXPIRE on a missing key is a no-op, never a resurrection.
   */
  async touch(id: string, ttlSeconds: number): Promise<void> {
    const key = this.prefix + id
    await this.redis.expire(key, ttlSeconds)
  }

  /**
   * Get all session keys (for debugging/admin purposes).
   * Note: This uses SCAN to avoid blocking Redis.
   */
  async keys(): Promise<string[]> {
    const keys = await scanKeys(this.redis, this.prefix + '*')
    return keys.map((key) => key.slice(this.prefix.length))
  }

  /**
   * Get the count of sessions (for monitoring).
   */
  async size(): Promise<number> {
    const keys = await this.keys()
    return keys.length
  }

  /**
   * Clear all sessions.
   * Use with caution in production!
   */
  async clear(): Promise<void> {
    const keys = await this.keys()
    if (keys.length > 0) {
      const prefixedKeys = keys.map((key) => this.prefix + key)
      await this.redis.del(...prefixedKeys)
    }
  }
}
