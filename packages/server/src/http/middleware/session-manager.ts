import { RedisSessionStore } from '../../redis/RedisSessionStore'
import {
  DEFAULT_SESSION_COOKIE_NAME,
  DEFAULT_SESSION_TTL_SECONDS,
  MemorySessionStore,
  type SessionOptions,
  type SessionStore,
} from './session'

export interface MemorySessionDriverOptions {
  /** Clock for expiry, injectable for tests. @default Date.now */
  now?: () => number
}

export interface RedisSessionDriverOptions {
  /**
   * An ioredis client, or a function returning one. A function is called on
   * the first request, never at construction, so a declared-but-unselected
   * store opens no socket.
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

/** Cookie and TTL settings plus the named stores one of which is the default. */
export interface SessionConfig extends Omit<SessionOptions, 'store'> {
  /** @default 'memory' */
  default?: string
  stores?: Record<string, SessionStoreConfig>
}

export interface SessionDriverContext {
  readonly ttlSeconds: number
  readonly cookieName: string
}

export type SessionDriverFactory<O = unknown> = (options: O, context: SessionDriverContext) => SessionStore

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
 * until a request asks. Only the default store's *name* is checked here, so a
 * `SESSION_DRIVER` typo fails the boot rather than the first login.
 */
export class SessionManager {
  /** Cookie and TTL settings for the middleware; `store` is resolved through {@link store}. */
  readonly options: Omit<SessionOptions, 'store'>

  private readonly defaultStoreName: string
  private readonly configs = new Map<string, SessionStoreConfig>()
  private readonly driverFactories = new Map<string, SessionDriverFactory>()
  private readonly resolved = new Map<string, SessionStore>()

  constructor(config: SessionConfig = {}) {
    const { default: defaultName = 'memory', stores = {}, ...options } = config
    this.options = options
    this.defaultStoreName = defaultName

    this.driverFactories.set('memory', (raw) => {
      const { now } = raw as MemorySessionDriverOptions
      return new MemorySessionStore(now)
    })
    this.driverFactories.set('redis', (raw) => {
      const { client, prefix } = raw as RedisSessionDriverOptions
      const redis = typeof client === 'function' ? client() : client
      return new RedisSessionStore(redis as ConstructorParameters<typeof RedisSessionStore>[0], { prefix })
    })

    for (const [name, storeConfig] of Object.entries(stores)) {
      this.configs.set(name, storeConfig)
    }

    // Like CacheManager, an undeclared default named `memory` is implied;
    // any other undeclared default is the SESSION_DRIVER typo this guards.
    if (!this.configs.has(defaultName)) {
      if (defaultName !== 'memory') {
        throw new Error(
          `Session store "${defaultName}" is not declared. Declare it under \`stores\` or use one of: ${
            this.storeNames().join(', ') || '(none declared)'
          }.`,
        )
      }
      this.configs.set('memory', { driver: 'memory' })
    }
  }

  /** The default store when `name` is omitted; built on first call, memoized after. */
  store(name?: string): SessionStore {
    const storeName = name ?? this.defaultStoreName

    const cached = this.resolved.get(storeName)
    if (cached) {
      return cached
    }

    const config = this.configs.get(storeName)
    if (!config) {
      throw new Error(`Session store "${storeName}" is not declared. Declared stores: ${this.storeNames().join(', ')}.`)
    }

    const { driver, ...driverOptions } = config
    const factory = this.driverFactories.get(driver)
    if (!factory) {
      throw new Error(
        `Unknown session driver "${driver}" for store "${storeName}". Register it with registerDriver(), or install the plugin that provides it.`,
      )
    }

    const store = factory(driverOptions, {
      ttlSeconds: this.options.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
      cookieName: this.options.cookieName ?? DEFAULT_SESSION_COOKIE_NAME,
    })
    this.resolved.set(storeName, store)
    return store
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

  hasDriver(name: string): boolean {
    return this.driverFactories.has(name)
  }

  getDefaultStoreName(): string {
    return this.defaultStoreName
  }

  storeNames(): string[] {
    return Array.from(this.configs.keys())
  }

  /**
   * Sweep expired sessions from the default store and from any other store
   * already built, on stores that support it (`deleteExpired`). Stores that
   * were declared but never selected are left unbuilt, so a `redis` entry an
   * environment does not use opens no connection here.
   */
  async pruneExpired(now: Date = new Date()): Promise<void> {
    const stores = new Set<SessionStore>([this.store(), ...this.resolved.values()])
    for (const store of stores) {
      if (isPrunable(store)) {
        await store.deleteExpired(now)
      }
    }
  }

  /** What `createSessionMiddleware` needs: the cookie/TTL settings and a lazy default store. */
  middlewareOptions(): SessionOptions {
    return { ...this.options, store: () => this.store() }
  }
}
