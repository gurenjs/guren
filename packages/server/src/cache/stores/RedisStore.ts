import type { CacheStore, RedisStoreOptions } from '../types'

/**
 * Redis interface (ioredis-compatible).
 */
interface RedisClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode?: string, duration?: number): Promise<unknown>
  setex(key: string, seconds: number, value: string): Promise<unknown>
  exists(...keys: string[]): Promise<number>
  del(...keys: string[]): Promise<number>
  incrby(key: string, increment: number): Promise<number>
  decrby(key: string, decrement: number): Promise<number>
  ttl(key: string): Promise<number>
  mget(...keys: string[]): Promise<(string | null)[]>
  keys(pattern: string): Promise<string[]>
  flushdb(): Promise<unknown>
  pipeline(): RedisPipeline
}

interface RedisPipeline {
  setex(key: string, seconds: number, value: string): this
  set(key: string, value: string): this
  exec(): Promise<unknown>
}

/**
 * Redis-backed cache store.
 *
 * @example
 * ```ts
 * import Redis from 'ioredis'
 *
 * const redis = new Redis(process.env.REDIS_URL)
 * const store = new RedisStore({ client: redis })
 *
 * await store.set('user:1', { name: 'John' }, 3600)
 * const user = await store.get<User>('user:1')
 * ```
 */
export class RedisStore implements CacheStore {
  private readonly client: RedisClient
  private readonly prefix: string

  constructor(options: RedisStoreOptions) {
    this.client = options.client as RedisClient
    this.prefix = options.prefix ?? 'cache:'
  }

  /**
   * Get the prefixed key.
   */
  private prefixKey(key: string): string {
    return `${this.prefix}${key}`
  }

  /**
   * Serialize a value for storage.
   */
  private serialize<T>(value: T): string {
    return JSON.stringify(value)
  }

  /**
   * Deserialize a stored value.
   */
  private deserialize<T>(value: string | null): T | null {
    if (value === null) {
      return null
    }

    try {
      return JSON.parse(value) as T
    } catch {
      return null
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.client.get(this.prefixKey(key))
    return this.deserialize<T>(value)
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const serialized = this.serialize(value)
    const prefixedKey = this.prefixKey(key)

    if (ttl) {
      await this.client.setex(prefixedKey, ttl, serialized)
    } else {
      await this.client.set(prefixedKey, serialized)
    }
  }

  async has(key: string): Promise<boolean> {
    const exists = await this.client.exists(this.prefixKey(key))
    return exists > 0
  }

  async delete(key: string): Promise<boolean> {
    const deleted = await this.client.del(this.prefixKey(key))
    return deleted > 0
  }

  async clear(): Promise<void> {
    const keys = await this.client.keys(`${this.prefix}*`)

    if (keys.length > 0) {
      await this.client.del(...keys)
    }
  }

  async increment(key: string, value = 1): Promise<number> {
    const prefixedKey = this.prefixKey(key)

    // Check if key exists, if not initialize to 0
    const exists = await this.client.exists(prefixedKey)
    if (!exists) {
      await this.client.set(prefixedKey, '0')
    }

    return this.client.incrby(prefixedKey, value)
  }

  async decrement(key: string, value = 1): Promise<number> {
    const prefixedKey = this.prefixKey(key)

    // Check if key exists, if not initialize to 0
    const exists = await this.client.exists(prefixedKey)
    if (!exists) {
      await this.client.set(prefixedKey, '0')
    }

    return this.client.decrby(prefixedKey, value)
  }

  async remember<T>(key: string, ttl: number, callback: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key)

    if (cached !== null) {
      return cached
    }

    const value = await callback()
    await this.set(key, value, ttl)
    return value
  }

  async rememberForever<T>(key: string, callback: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key)

    if (cached !== null) {
      return cached
    }

    const value = await callback()
    await this.set(key, value)
    return value
  }

  async getMany<T>(keys: string[]): Promise<Map<string, T | null>> {
    const prefixedKeys = keys.map((key) => this.prefixKey(key))
    const values = await this.client.mget(...prefixedKeys)

    const result = new Map<string, T | null>()

    for (let i = 0; i < keys.length; i++) {
      result.set(keys[i], this.deserialize<T>(values[i]))
    }

    return result
  }

  async setMany<T>(items: Map<string, T>, ttl?: number): Promise<void> {
    const pipeline = this.client.pipeline()

    for (const [key, value] of items) {
      const serialized = this.serialize(value)
      const prefixedKey = this.prefixKey(key)

      if (ttl) {
        pipeline.setex(prefixedKey, ttl, serialized)
      } else {
        pipeline.set(prefixedKey, serialized)
      }
    }

    await pipeline.exec()
  }

  async deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) {
      return 0
    }

    const prefixedKeys = keys.map((key) => this.prefixKey(key))
    return this.client.del(...prefixedKeys)
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(this.prefixKey(key))
  }

  /**
   * Get the Redis client instance.
   */
  getClient(): unknown {
    return this.client
  }

  /**
   * Get the key prefix.
   */
  getPrefix(): string {
    return this.prefix
  }
}
