import type {
  CacheStore,
  TaggableCacheStore,
  CacheStoreFactory,
  CacheConfig,
  StoreConfig,
  MemoryStoreOptions,
  RedisStoreOptions,
  FileStoreOptions,
  TaggedCacheStore,
} from './types'
import { MemoryStore } from './stores/MemoryStore'
import { RedisStore } from './stores/RedisStore'
import { FileStore } from './stores/FileStore'
import { TaggedCache } from './TaggedCache'

/**
 * Taggable wrapper that adds tag support to any cache store.
 */
class TaggableCacheStoreWrapper implements TaggableCacheStore {
  constructor(private readonly store: CacheStore) {}

  get<T>(key: string): Promise<T | null> {
    return this.store.get<T>(key)
  }

  set<T>(key: string, value: T, ttl?: number): Promise<void> {
    return this.store.set(key, value, ttl)
  }

  has(key: string): Promise<boolean> {
    return this.store.has(key)
  }

  delete(key: string): Promise<boolean> {
    return this.store.delete(key)
  }

  clear(): Promise<void> {
    return this.store.clear()
  }

  increment(key: string, value?: number): Promise<number> {
    return this.store.increment(key, value)
  }

  decrement(key: string, value?: number): Promise<number> {
    return this.store.decrement(key, value)
  }

  remember<T>(key: string, ttl: number, callback: () => Promise<T>): Promise<T> {
    return this.store.remember(key, ttl, callback)
  }

  rememberForever<T>(key: string, callback: () => Promise<T>): Promise<T> {
    return this.store.rememberForever(key, callback)
  }

  getMany<T>(keys: string[]): Promise<Map<string, T | null>> {
    return this.store.getMany<T>(keys)
  }

  setMany<T>(items: Map<string, T>, ttl?: number): Promise<void> {
    return this.store.setMany(items, ttl)
  }

  deleteMany(keys: string[]): Promise<number> {
    return this.store.deleteMany(keys)
  }

  ttl(key: string): Promise<number> {
    return this.store.ttl(key)
  }

  tags(tags: string[]): TaggedCacheStore {
    return new TaggedCache(this.store, tags)
  }
}

/**
 * Cache manager for handling multiple cache stores.
 *
 * @example
 * ```ts
 * const cache = new CacheManager({
 *   default: 'redis',
 *   stores: {
 *     memory: { driver: 'memory' },
 *     redis: { driver: 'redis', client: redisClient },
 *     file: { driver: 'file', path: './storage/cache' },
 *   }
 * })
 *
 * // Use the default store
 * await cache.store().set('key', 'value', 3600)
 *
 * // Use a specific store
 * await cache.store('memory').set('key', 'value')
 *
 * // Use tagged cache
 * await cache.store().tags(['posts', 'user:1']).set('user:1:posts', posts)
 * await cache.store().tags(['user:1']).flush()
 * ```
 */
export class CacheManager {
  private readonly defaultStoreName: string
  private readonly storeFactories: Map<string, CacheStoreFactory> = new Map()
  private readonly resolvedStores: Map<string, TaggableCacheStore> = new Map()

  constructor(config: CacheConfig = {}) {
    this.defaultStoreName = config.default ?? 'memory'

    // Register built-in drivers
    this.registerBuiltinDrivers()

    // Register stores from config
    if (config.stores) {
      for (const [name, storeConfig] of Object.entries(config.stores)) {
        this.registerStoreFromConfig(name, storeConfig)
      }
    }

    // Register default memory store if no stores configured
    if (!this.storeFactories.has(this.defaultStoreName) && this.defaultStoreName === 'memory') {
      this.storeFactories.set('memory', () => new MemoryStore())
    }
  }

  private driverFactories: Map<string, (options: unknown) => CacheStore> = new Map()

  /**
   * Register built-in store drivers.
   */
  private registerBuiltinDrivers(): void {
    // Memory driver
    this.driverFactories.set('memory', (options: unknown) => {
      return new MemoryStore(options as MemoryStoreOptions)
    })

    // Redis driver
    this.driverFactories.set('redis', (options: unknown) => {
      return new RedisStore(options as RedisStoreOptions)
    })

    // File driver
    this.driverFactories.set('file', (options: unknown) => {
      return new FileStore(options as FileStoreOptions)
    })
  }

  /**
   * Register a store from configuration.
   */
  private registerStoreFromConfig(
    name: string,
    config: StoreConfig
  ): void {
    const { driver, ...options } = config
    const factory = this.driverFactories.get(driver)

    if (!factory) {
      throw new Error(`Unknown cache driver: ${driver}`)
    }

    this.storeFactories.set(name, () => factory(options))
  }

  /**
   * Get a cache store by name.
   * Returns the default store if no name is specified.
   */
  store(name?: string): TaggableCacheStore {
    const storeName = name ?? this.defaultStoreName

    // Return cached store if already resolved
    const cached = this.resolvedStores.get(storeName)
    if (cached) {
      return cached
    }

    // Get factory and create store
    const factory = this.storeFactories.get(storeName)
    if (!factory) {
      throw new Error(`Cache store not found: ${storeName}`)
    }

    const store = new TaggableCacheStoreWrapper(factory())
    this.resolvedStores.set(storeName, store)
    return store
  }

  /**
   * Register a custom store factory.
   */
  registerStore(name: string, factory: CacheStoreFactory): void {
    this.storeFactories.set(name, factory)
    // Clear cached instance if exists
    this.resolvedStores.delete(name)
  }

  /**
   * Register a custom driver.
   */
  registerDriver(name: string, factory: (options: unknown) => CacheStore): void {
    this.driverFactories.set(name, factory)
  }

  /**
   * Check if a store is registered.
   */
  hasStore(name: string): boolean {
    return this.storeFactories.has(name)
  }

  /**
   * Get the default store name.
   */
  getDefaultStoreName(): string {
    return this.defaultStoreName
  }

  /**
   * Get all registered store names.
   */
  getStoreNames(): string[] {
    return Array.from(this.storeFactories.keys())
  }
}

/**
 * Create a cache manager with configuration.
 */
export function createCacheManager(config?: CacheConfig): CacheManager {
  return new CacheManager(config)
}
