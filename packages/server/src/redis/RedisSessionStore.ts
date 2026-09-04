import type { Redis } from 'ioredis'
import type { SessionStore, SessionData } from '../http/middleware/session'
import { scanKeys } from './scan-keys'

export interface RedisSessionStoreOptions {
  /** @default 'session:' */
  prefix?: string
}

export class RedisSessionStore implements SessionStore {
  private readonly prefix: string

  constructor(
    private readonly redis: Redis,
    options: RedisSessionStoreOptions = {}
  ) {
    this.prefix = options.prefix ?? 'session:'
  }

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

  async write(id: string, data: SessionData, ttlSeconds: number): Promise<void> {
    const key = this.prefix + id
    const serialized = JSON.stringify(data)
    await this.redis.setex(key, ttlSeconds, serialized)
  }

  async destroy(id: string): Promise<void> {
    const key = this.prefix + id
    await this.redis.del(key)
  }

  /** EXPIRE on a missing key is a no-op, never a resurrection. */
  async touch(id: string, ttlSeconds: number): Promise<void> {
    const key = this.prefix + id
    await this.redis.expire(key, ttlSeconds)
  }

  /** Debugging/admin. */
  async keys(): Promise<string[]> {
    const keys = await scanKeys(this.redis, this.prefix + '*')
    return keys.map((key) => key.slice(this.prefix.length))
  }

  async size(): Promise<number> {
    const keys = await this.keys()
    return keys.length
  }

  async clear(): Promise<void> {
    const keys = await this.keys()
    if (keys.length > 0) {
      const prefixedKeys = keys.map((key) => this.prefix + key)
      await this.redis.del(...prefixedKeys)
    }
  }
}
