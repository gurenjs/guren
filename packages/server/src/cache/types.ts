export interface CacheStore {
  get<T>(key: string): Promise<T | null>

  /** @param ttl Time-to-live in seconds. */
  set<T>(key: string, value: T, ttl?: number): Promise<void>

  has(key: string): Promise<boolean>

  delete(key: string): Promise<boolean>

  clear(): Promise<void>

  /** Returns the new value; `value` defaults to 1. */
  increment(key: string, value?: number): Promise<number>

  /** Returns the new value; `value` defaults to 1. */
  decrement(key: string, value?: number): Promise<number>

  /** Cached value, or the callback's result stored for `ttl` seconds. */
  remember<T>(key: string, ttl: number, callback: () => Promise<T>): Promise<T>

  /** Cached value, or the callback's result stored without expiry. */
  rememberForever<T>(key: string, callback: () => Promise<T>): Promise<T>

  getMany<T>(keys: string[]): Promise<Map<string, T | null>>

  setMany<T>(items: Map<string, T>, ttl?: number): Promise<void>

  deleteMany(keys: string[]): Promise<number>

  /**
   * Remaining TTL in seconds; -1 when the key has no expiration, -2 when it
   * does not exist.
   */
  ttl(key: string): Promise<number>
}

export interface TaggableCacheStore extends CacheStore {
  tags(tags: string[]): TaggedCacheStore
}

export interface TaggedCacheStore extends CacheStore {
  /** Flush all items with the current tags. */
  flush(): Promise<void>

  getTags(): string[]
}

export type CacheStoreFactory = () => CacheStore

export interface MemoryStoreOptions {
  /** @default Infinity */
  maxSize?: number

  /** Check interval for expired items, in milliseconds. @default 60000 */
  checkPeriod?: number

  /**
   * Clock for TTL calculations, injectable for tests. Must return a Unix
   * timestamp in milliseconds: persisted `expiresAt` values are read by other
   * instances using the default clock.
   * @default Date.now
   */
  now?: () => number
}

export interface RedisStoreOptions {
  /** Redis client instance (ioredis). */
  client: unknown

  /** @default 'cache:' */
  prefix?: string
}

export interface FileStoreOptions {
  /** Directory path for cache files. */
  path: string

  /** @default '.cache' */
  extension?: string

  /**
   * Clock for TTL calculations, injectable for tests. Must return a Unix
   * timestamp in milliseconds: persisted `expiresAt` values are read by other
   * instances using the default clock.
   * @default Date.now
   */
  now?: () => number
}

export type StoreConfig =
  | { driver: 'memory' } & MemoryStoreOptions
  | { driver: 'redis' } & RedisStoreOptions
  | { driver: 'file' } & FileStoreOptions

export interface CacheConfig {
  /** @default 'memory' */
  default?: string

  stores?: Record<string, StoreConfig>
}

export interface CachedItem<T = unknown> {
  value: T
  expiresAt: number | null
}
