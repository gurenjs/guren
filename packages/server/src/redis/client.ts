import Redis from 'ioredis'
import type { RedisOptions } from 'ioredis'

export interface RedisClientOptions extends RedisOptions {
  /** Overrides host/port/password when set. */
  url?: string

  /** @default '' */
  keyPrefix?: string
}

export function createRedisClient(options: RedisClientOptions = {}): Redis {
  const { url, ...redisOptions } = options

  if (url) {
    return new Redis(url, redisOptions)
  }

  return new Redis(redisOptions)
}

export { Redis }
export type { RedisOptions }
