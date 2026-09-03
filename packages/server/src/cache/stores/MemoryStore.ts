import type { CacheStore, MemoryStoreOptions, CachedItem } from '../types'

/** In-memory cache store. */
export class MemoryStore implements CacheStore {
  private readonly cache: Map<string, CachedItem> = new Map()
  private readonly maxSize: number
  private readonly now: () => number
  private checkInterval: ReturnType<typeof setInterval> | null = null

  constructor(options: MemoryStoreOptions = {}) {
    this.maxSize = options.maxSize ?? Infinity
    this.now = options.now ?? Date.now

    const checkPeriod = options.checkPeriod ?? 60000
    if (checkPeriod > 0) {
      this.checkInterval = setInterval(() => {
        this.removeExpired()
      }, checkPeriod)

      // So the interval cannot keep the process alive.
      if (this.checkInterval.unref) {
        this.checkInterval.unref()
      }
    }
  }

  private removeExpired(): void {
    const now = this.now()
    for (const [key, item] of this.cache) {
      if (item.expiresAt !== null && item.expiresAt <= now) {
        this.cache.delete(key)
      }
    }
  }

  private isExpired(item: CachedItem): boolean {
    return item.expiresAt !== null && item.expiresAt <= this.now()
  }

  private evictIfNeeded(): void {
    if (this.cache.size >= this.maxSize) {
      // The oldest item is the Map's first key.
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const item = this.cache.get(key)

    if (!item) {
      return null
    }

    if (this.isExpired(item)) {
      this.cache.delete(key)
      return null
    }

    return item.value as T
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    this.evictIfNeeded()

    const expiresAt = ttl ? this.now() + ttl * 1000 : null

    this.cache.set(key, {
      value,
      expiresAt,
    })
  }

  async has(key: string): Promise<boolean> {
    const item = this.cache.get(key)

    if (!item) {
      return false
    }

    if (this.isExpired(item)) {
      this.cache.delete(key)
      return false
    }

    return true
  }

  async delete(key: string): Promise<boolean> {
    return this.cache.delete(key)
  }

  async clear(): Promise<void> {
    this.cache.clear()
  }

  async increment(key: string, value = 1): Promise<number> {
    const current = await this.get<number>(key)
    const newValue = (current ?? 0) + value

    // Preserve any existing TTL.
    const item = this.cache.get(key)
    const ttl = item?.expiresAt
      ? Math.max(0, Math.ceil((item.expiresAt - this.now()) / 1000))
      : undefined

    await this.set(key, newValue, ttl)
    return newValue
  }

  async decrement(key: string, value = 1): Promise<number> {
    return this.increment(key, -value)
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
    const result = new Map<string, T | null>()

    for (const key of keys) {
      result.set(key, await this.get<T>(key))
    }

    return result
  }

  async setMany<T>(items: Map<string, T>, ttl?: number): Promise<void> {
    for (const [key, value] of items) {
      await this.set(key, value, ttl)
    }
  }

  async deleteMany(keys: string[]): Promise<number> {
    let deleted = 0

    for (const key of keys) {
      if (await this.delete(key)) {
        deleted++
      }
    }

    return deleted
  }

  async ttl(key: string): Promise<number> {
    const item = this.cache.get(key)

    if (!item) {
      return -2
    }

    if (this.isExpired(item)) {
      this.cache.delete(key)
      return -2
    }

    if (item.expiresAt === null) {
      return -1
    }

    return Math.max(0, Math.ceil((item.expiresAt - this.now()) / 1000))
  }

  size(): number {
    return this.cache.size
  }

  /** Stop the expiration check interval. */
  destroy(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
  }
}
