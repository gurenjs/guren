import Redis from 'ioredis'
import type { RedisOptions } from 'ioredis'

/**
 * Options for creating a Redis client.
 */
export interface RedisClientOptions extends RedisOptions {
  /**
   * Redis connection URL (e.g., 'redis://localhost:6379').
   * If provided, overrides host/port/password.
   */
  url?: string

  /**
   * Key prefix for all operations.
   * @default ''
   */
  keyPrefix?: string
}

/**
 * Create a Redis client with the given options.
 *
 * @example
 * ```ts
 * // Using URL
 * const redis = createRedisClient({ url: 'redis://localhost:6379' })
 *
 * // Using host/port
 * const redis = createRedisClient({ host: 'localhost', port: 6379 })
 *
 * // With key prefix
 * const redis = createRedisClient({
 *   url: process.env.REDIS_URL,
 *   keyPrefix: 'myapp:',
 * })
 * ```
 */
export function createRedisClient(options: RedisClientOptions = {}): Redis {
  const { url, ...redisOptions } = options

  if (url) {
    return new Redis(url, redisOptions)
  }

  return new Redis(redisOptions)
}

/**
 * Re-export Redis class for type usage.
 */
export { Redis }
export type { RedisOptions }
