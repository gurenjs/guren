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
import { claimHotDisposable, isHotReloadRuntime } from '../hot-reload/hot-disposables'

/** Adds tag support to any cache store. */
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

/** Cache manager for handling multiple cache stores. */
export class CacheManager {
  private readonly defaultStoreName: string
  private readonly storeFactories: Map<string, CacheStoreFactory> = new Map()
  private readonly resolvedStores: Map<string, TaggableCacheStore> = new Map()
  /**
   * Where this manager was built, for identifying its stores across hot reloads.
   * Captured here rather than in `store()` because stores resolve lazily, from
   * whichever request first asks for one. Skipped outside `--hot`, where the
   * stack string would be held for the manager's lifetime and never read.
   */
  private readonly builtAt: string | undefined

  constructor(config: CacheConfig = {}) {
    this.builtAt = isHotReloadRuntime() ? new Error().stack : undefined
    this.defaultStoreName = config.default ?? 'memory'

    this.registerBuiltinDrivers()

    if (config.stores) {
      for (const [name, storeConfig] of Object.entries(config.stores)) {
        this.registerStoreFromConfig(name, storeConfig)
      }
    }

    if (!this.storeFactories.has(this.defaultStoreName) && this.defaultStoreName === 'memory') {
      this.storeFactories.set('memory', () => new MemoryStore())
    }
  }

  private driverFactories: Map<string, (options: unknown) => CacheStore> = new Map()

  private registerBuiltinDrivers(): void {
    this.driverFactories.set('memory', (options: unknown) => {
      return new MemoryStore(options as MemoryStoreOptions)
    })

    this.driverFactories.set('redis', (options: unknown) => {
      return new RedisStore(options as RedisStoreOptions)
    })

    this.driverFactories.set('file', (options: unknown) => {
      return new FileStore(options as FileStoreOptions)
    })
  }

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

  /** Returns the default store if no name is given. */
  store(name?: string): TaggableCacheStore {
    const storeName = name ?? this.defaultStoreName

    const cached = this.resolvedStores.get(storeName)
    if (cached) {
      return cached
    }

    const factory = this.storeFactories.get(storeName)
    if (!factory) {
      throw new Error(`Cache store not found: ${storeName} (declared: ${this.getStoreNames().join(', ')})`)
    }

    const raw = factory()
    this.stopPreviousStore(storeName, raw)

    const store = new TaggableCacheStoreWrapper(raw)
    this.resolvedStores.set(storeName, store)
    return store
  }

  /**
   * Under `bun --hot`, stops the sweep timer held by the store this one
   * replaces. Registered from here because the store's name is known here, and
   * that name keeps two memory stores in one config from cancelling each
   * other's sweep.
   */
  private stopPreviousStore(storeName: string, store: CacheStore): void {
    const disposable = store as CacheStore & { destroy?: () => void }

    if (typeof disposable.destroy === 'function') {
      claimHotDisposable('cache-store', this.builtAt, storeName, () => disposable.destroy?.())
    }
  }

  registerStore(name: string, factory: CacheStoreFactory): void {
    this.storeFactories.set(name, factory)
    this.resolvedStores.delete(name)
  }

  registerDriver(name: string, factory: (options: unknown) => CacheStore): void {
    this.driverFactories.set(name, factory)
  }

  hasStore(name: string): boolean {
    return this.storeFactories.has(name)
  }

  getDefaultStoreName(): string {
    return this.defaultStoreName
  }

  getStoreNames(): string[] {
    return Array.from(this.storeFactories.keys())
  }
}

export function createCacheManager(config?: CacheConfig): CacheManager {
  return new CacheManager(config)
}
