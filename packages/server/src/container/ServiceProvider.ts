import type { Container } from './Container'
import type { Provider } from './types'

/**
 * Constructor shape accepted wherever a provider class can be registered.
 */
export type ServiceProviderConstructor = new (container: Container) => ServiceProvider

/**
 * Base service provider class.
 *
 * Service providers are the central place of all application bootstrapping.
 * Your own application, as well as all core services, are bootstrapped via providers.
 *
 * @example
 * ```typescript
 * export class AppServiceProvider extends ServiceProvider {
 *   register(): void {
 *     // Register bindings
 *     this.container.singleton('db', (c) => new Database(c.make('config')))
 *   }
 *
 *   boot(): void {
 *     // Bootstrap after all providers registered
 *     const db = this.container.make<Database>('db')
 *     db.connect()
 *   }
 * }
 * ```
 */
export abstract class ServiceProvider implements Provider {
  /**
   * Whether this provider should be deferred.
   * Deferred providers are only loaded when one of their provided services is requested.
   */
  static deferred: boolean = false

  /**
   * The services provided by this provider (for deferred loading).
   */
  static provides: string[] = []

  constructor(protected container: Container) {}

  /**
   * Register any application services.
   * This is called before any other providers have booted.
   */
  abstract register(): void | Promise<void>

  /**
   * Bootstrap any application services.
   * This is called after all providers have registered.
   */
  boot?(): void | Promise<void>

  /**
   * Get the services provided by the provider.
   */
  provides(): string[] {
    return (this.constructor as typeof ServiceProvider).provides
  }

  /**
   * Check if this provider is deferred.
   */
  isDeferred(): boolean {
    return (this.constructor as typeof ServiceProvider).deferred
  }
}

/**
 * Provider manager for registering and booting providers.
 */
export class ProviderManager {
  protected providers: ServiceProvider[] = []
  protected registered: Set<ServiceProvider> = new Set()
  protected booted: Set<ServiceProvider> = new Set()
  protected deferredProviders: Map<string, ServiceProvider> = new Map()
  /** Per service, the boot of an already-activated deferred provider, so a later loadDeferredProvider() awaits that boot */
  private deferredActivations: Map<string, Promise<void>> = new Map()
  private allBooted = false

  constructor(protected container: Container) {}

  /**
   * Register a provider.
   */
  register(providerOrClass: ServiceProvider | ServiceProviderConstructor): this {
    if (this.allBooted) {
      const name =
        providerOrClass instanceof ServiceProvider
          ? providerOrClass.constructor.name
          : providerOrClass.name
      throw new Error(
        `Cannot register provider "${name}" after bootAll() has been called. ` +
        'Register all providers before booting the application.',
      )
    }

    const provider =
      providerOrClass instanceof ServiceProvider
        ? providerOrClass
        : new providerOrClass(this.container)

    if (provider.isDeferred() && provider.provides().length === 0) {
      throw new Error(
        `Deferred provider "${provider.constructor.name}" must declare at least one service in "provides", ` +
        'otherwise it can never be loaded.',
      )
    }

    // Deferred providers are loaded on-demand when Container.make() is called
    if (provider.isDeferred()) {
      for (const service of provider.provides()) {
        this.deferredProviders.set(service, provider)
      }
    } else {
      this.providers.push(provider)
    }

    return this
  }

  /**
   * Register multiple providers.
   */
  registerMany(providers: Array<ServiceProvider | ServiceProviderConstructor>): this {
    for (const provider of providers) {
      this.register(provider)
    }
    return this
  }

  /**
   * Register all non-deferred providers.
   */
  async registerAll(): Promise<void> {
    for (const provider of this.providers) {
      if (!this.registered.has(provider)) {
        await provider.register()
        this.registered.add(provider)
      }
    }
  }

  /**
   * Boot all registered providers.
   */
  async bootAll(): Promise<void> {
    for (const provider of this.providers) {
      if (!this.booted.has(provider) && this.registered.has(provider)) {
        await provider.boot?.()
        this.booted.add(provider)
      }
    }
    this.allBooted = true

    // Wire deferred provider resolution into Container.make()
    if (this.deferredProviders.size > 0) {
      this.container.deferredProviderLoader = (service: string) =>
        this.activateDeferredProvider(service)
    }
  }

  /**
   * Load a deferred provider for a service: register it, boot it, and drop
   * its services from the deferred set. Resolves once boot() has finished,
   * also when the provider was already activated by Container.make().
   */
  async loadDeferredProvider(service: string): Promise<void> {
    await (this.activateDeferredProvider(service) ?? this.deferredActivations.get(service))
  }

  /**
   * The synchronous half of deferred loading, which is what lets a
   * synchronous `Container.make()` resolve a deferred service: `register()`
   * runs before this returns, so its bindings are in the container by the
   * time the caller reads them, and a synchronous throw reaches the caller.
   * `boot()` follows on the returned promise, which make() does not await: a
   * boot failure surfaces as an unhandled rejection rather than silently.
   * Services are unclaimed from the deferred set up front so a re-entrant
   * make() for a sibling service does not register the provider twice.
   */
  private activateDeferredProvider(service: string): Promise<void> | undefined {
    const provider = this.deferredProviders.get(service)
    if (!provider) return undefined

    const registering = provider.register()
    this.registered.add(provider)
    this.providers.push(provider)
    for (const providedService of provider.provides()) {
      this.deferredProviders.delete(providedService)
    }

    const activation = Promise.resolve(registering).then(async () => {
      await provider.boot?.()
      this.booted.add(provider)
    })
    for (const providedService of provider.provides()) {
      this.deferredActivations.set(providedService, activation)
    }
    return activation
  }

  /**
   * Check if a service is provided by a deferred provider.
   */
  isDeferredService(service: string): boolean {
    return this.deferredProviders.has(service)
  }

  /**
   * Get all registered providers.
   */
  getProviders(): ServiceProvider[] {
    return [...this.providers]
  }

  /**
   * Get all deferred services.
   */
  getDeferredServices(): string[] {
    return Array.from(this.deferredProviders.keys())
  }
}
