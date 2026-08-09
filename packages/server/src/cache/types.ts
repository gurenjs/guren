/**
 * Cache store interface.
 */
export interface CacheStore {
  /**
   * Get a value from the cache.
   */
  get<T>(key: string): Promise<T | null>

  /**
   * Set a value in the cache.
   * @param key Cache key
   * @param value Value to cache
   * @param ttl Time-to-live in seconds (optional)
   */
  set<T>(key: string, value: T, ttl?: number): Promise<void>

  /**
   * Check if a key exists in the cache.
   */
  has(key: string): Promise<boolean>

  /**
   * Delete a key from the cache.
   */
  delete(key: string): Promise<boolean>

  /**
   * Clear all items from the cache.
   */
  clear(): Promise<void>

  /**
   * Increment a numeric value.
   * @param key Cache key
   * @param value Amount to increment (default: 1)
   * @returns The new value
   */
  increment(key: string, value?: number): Promise<number>

  /**
   * Decrement a numeric value.
   * @param key Cache key
   * @param value Amount to decrement (default: 1)
   * @returns The new value
   */
  decrement(key: string, value?: number): Promise<number>

  /**
   * Get a value from the cache, or store and return the result of the callback.
   * @param key Cache key
   * @param ttl Time-to-live in seconds
   * @param callback Function to compute the value if not cached
   */
  remember<T>(key: string, ttl: number, callback: () => Promise<T>): Promise<T>

  /**
   * Get a value from the cache, or store and return the result of the callback forever.
   * @param key Cache key
   * @param callback Function to compute the value if not cached
   */
  rememberForever<T>(key: string, callback: () => Promise<T>): Promise<T>

  /**
   * Get multiple values from the cache.
   */
  getMany<T>(keys: string[]): Promise<Map<string, T | null>>

  /**
   * Set multiple values in the cache.
   */
  setMany<T>(items: Map<string, T>, ttl?: number): Promise<void>

  /**
   * Delete multiple keys from the cache.
   */
  deleteMany(keys: string[]): Promise<number>

  /**
   * Get the remaining TTL for a key in seconds.
   * Returns -1 if the key has no expiration, -2 if the key does not exist.
   */
  ttl(key: string): Promise<number>
}

/**
 * Cache store that supports tagging.
 */
export interface TaggableCacheStore extends CacheStore {
  /**
   * Get a tagged cache instance.
   */
  tags(tags: string[]): TaggedCacheStore
}

/**
 * Tagged cache store interface.
 */
export interface TaggedCacheStore extends CacheStore {
  /**
   * Flush all items with the current tags.
   */
  flush(): Promise<void>

  /**
   * Get the current tags.
   */
  getTags(): string[]
}

/**
 * Cache store factory function.
 */
export type CacheStoreFactory = () => CacheStore

/**
 * Memory store options.
 */
export interface MemoryStoreOptions {
  /**
   * Maximum number of items to store.
   * @default Infinity
   */
  maxSize?: number

  /**
   * Check interval for expired items in milliseconds.
   * @default 60000 (1 minute)
   */
  checkPeriod?: number

  /**
   * Clock used for TTL calculations. Must return a Unix timestamp in
   * milliseconds (compatible with `Date.now()`) — persisted `expiresAt`
   * values are read by other instances using the default clock.
   * Injectable for tests.
   * @default Date.now
   */
  now?: () => number
}

/**
 * Redis store options.
 */
export interface RedisStoreOptions {
  /**
   * Redis client instance (ioredis).
   */
  client: unknown

  /**
   * Key prefix.
   * @default 'cache:'
   */
  prefix?: string
}

/**
 * File store options.
 */
export interface FileStoreOptions {
  /**
   * Directory path for cache files.
   */
  path: string

  /**
   * File extension.
   * @default '.cache'
   */
  extension?: string

  /**
   * Clock used for TTL calculations. Must return a Unix timestamp in
   * milliseconds (compatible with `Date.now()`) — persisted `expiresAt`
   * values are read by other instances using the default clock.
   * Injectable for tests.
   * @default Date.now
   */
  now?: () => number
}

/**
 * Store configuration union type.
 */
export type StoreConfig =
  | { driver: 'memory' } & MemoryStoreOptions
  | { driver: 'redis' } & RedisStoreOptions
  | { driver: 'file' } & FileStoreOptions

/**
 * Cache manager configuration.
 */
export interface CacheConfig {
  /**
   * Default store name.
   * @default 'memory'
   */
  default?: string

  /**
   * Store configurations.
   */
  stores?: Record<string, StoreConfig>
}

/**
 * Cached item with metadata.
 */
export interface CachedItem<T = unknown> {
  value: T
  expiresAt: number | null
}
