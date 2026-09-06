import { resolveLazyRedisClient } from '../../redis/lazy-client'
import { RedisSessionStore } from '../../redis/RedisSessionStore'
import { MemorySessionStore, type SessionCookieOptions, type SessionStore } from './session'

export interface MemorySessionDriverOptions {
  /** Clock for expiry, injectable for tests. @default Date.now */
  now?: () => number
}

export interface RedisSessionDriverOptions {
  /**
   * An ioredis client, or a function returning one *synchronously* (ioredis
   * connects lazily on its own). A function runs when the store is first
   * built, so a declared-but-unselected store opens no socket.
   */
  client: unknown
  /** @default 'session:' */
  prefix?: string
}

/**
 * Open driver registry (RFC 0020 §1). A plugin adds a driver by augmenting this
 * interface, which is what makes `{ driver: 'dynamodb' }` type-check in an
 * app's config, and by calling `registerDriver()` on the bound manager.
 * `@guren/core` adds `database` here; server cannot, since it must not depend
 * on the ORM.
 */
export interface SessionDrivers {
  memory: MemorySessionDriverOptions
  redis: RedisSessionDriverOptions
}

export type SessionStoreConfig = {
  [K in keyof SessionDrivers]: { driver: K } & SessionDrivers[K]
}[keyof SessionDrivers]

/** The store `SessionConfig.default` names when it names none, and the one driver that shares no state between requests. */
export const DEFAULT_SESSION_STORE_NAME = 'memory'
export const PER_PROCESS_SESSION_DRIVERS: ReadonlySet<string> = new Set([DEFAULT_SESSION_STORE_NAME])

/** Cookie and TTL settings plus the named stores one of which is the default. */
export interface SessionConfig extends SessionCookieOptions {
  /** @default 'memory' */
  default?: string
  stores?: Record<string, SessionStoreConfig>
}

/** Receives the store's config minus `driver`. Per-write TTLs arrive through `SessionStore.write`. */
export type SessionDriverFactory<O = unknown> = (options: O) => SessionStore

/** A store that can sweep expired rows; `pruneExpired()` calls it where present. */
interface PrunableSessionStore extends SessionStore {
  deleteExpired(now?: Date): Promise<void>
}

function isPrunable(store: SessionStore): store is PrunableSessionStore {
  return typeof (store as Partial<PrunableSessionStore>).deleteExpired === 'function'
}

/**
 * Resolves session stores by name from declared configs and registered drivers.
 * Lazy and memoized: a driver registered after construction (a plugin's
 * `register()`) still serves a store declared first, and nothing connects
 * until a request asks. Only the default store's *name* is checked here;
 * `assertDriverRegistered()` is the boot-time check for its driver.
 */
export class SessionManager {
  /** Cookie and TTL settings for the middleware; the store is resolved through {@link store}. */
  readonly options: SessionCookieOptions

  private readonly defaultStoreName: string
  private readonly configs = new Map<string, SessionStoreConfig>()
  private readonly driverFactories = new Map<string, SessionDriverFactory>()
  private readonly resolved = new Map<string, SessionStore>()

  constructor(config: SessionConfig = {}) {
    const { default: defaultName = DEFAULT_SESSION_STORE_NAME, stores = {}, ...options } = config
    this.options = options
    this.defaultStoreName = defaultName

    this.registerDriver('memory', ({ now }) => new MemorySessionStore(now))
    this.registerDriver('redis', ({ client, prefix }) => {
      const redis = resolveLazyRedisClient(client, 'Session store "redis"')
      return new RedisSessionStore(redis as ConstructorParameters<typeof RedisSessionStore>[0], { prefix })
    })

    // Unlike cache/storage, `memory` is declared even when it is not the
    // default: `SESSION_DRIVER=memory` needs no entry, and it is the fallback.
    this.configs.set(DEFAULT_SESSION_STORE_NAME, { driver: 'memory' })
    for (const [name, storeConfig] of Object.entries(stores)) {
      this.configs.set(name, storeConfig)
    }

    if (!this.configs.has(defaultName)) {
      throw new Error(`Session store not found: ${defaultName} (declared: ${this.getStoreNames().join(', ')})`)
    }
  }

  /** The default store when `name` is omitted; built on first call, memoized after. */
  store(name?: string): SessionStore {
    const storeName = name ?? this.defaultStoreName

    const cached = this.resolved.get(storeName)
    if (cached) {
      return cached
    }

    const { factory, options } = this.resolve(storeName)
    const store = factory(options)
    this.resolved.set(storeName, store)
    return store
  }

  /**
   * Fail now, with `store()`'s own message, if the store's driver is missing,
   * without building the store: what a boot hook can afford where a Redis
   * socket or a Workers binding cannot.
   */
  assertDriverRegistered(name?: string): void {
    this.resolve(name ?? this.defaultStoreName)
  }

  registerDriver<K extends keyof SessionDrivers>(name: K, factory: SessionDriverFactory<SessionDrivers[K]>): void
  registerDriver(name: string, factory: SessionDriverFactory): void
  registerDriver(name: string, factory: SessionDriverFactory): void {
    this.driverFactories.set(name, factory)
    // A store already built by the driver this replaces would otherwise outlive it.
    for (const [storeName, config] of this.configs) {
      if (config.driver === name) {
        this.resolved.delete(storeName)
      }
    }
  }

  getStoreNames(): string[] {
    return Array.from(this.configs.keys())
  }

  /**
   * Sweep expired sessions from the default store and from any other store
   * already built, on stores that support it (`deleteExpired`). Stores that
   * were declared but never selected are left unbuilt, so a `redis` entry an
   * environment does not use opens no connection here.
   */
  async pruneExpired(now: Date = new Date()): Promise<void> {
    this.store()
    await Promise.all([...this.resolved.values()].filter(isPrunable).map((store) => store.deleteExpired(now)))
  }

  private resolve(storeName: string): { factory: SessionDriverFactory; options: Record<string, unknown> } {
    const config = this.configs.get(storeName)
    if (!config) {
      throw new Error(`Session store not found: ${storeName} (declared: ${this.getStoreNames().join(', ')})`)
    }
    const { driver, ...options } = config
    const factory = this.driverFactories.get(driver)
    if (!factory) {
      throw new Error(
        `Unknown session driver: ${driver} (session store "${storeName}"). Registered: ${[...this.driverFactories.keys()].join(', ')}. `
        + 'Register it with registerDriver(), or build the manager with the factory that provides it.',
      )
    }
    return { factory, options }
  }
}
