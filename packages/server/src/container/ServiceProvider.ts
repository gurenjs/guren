import type { Container } from './Container'
import type { Provider } from './types'

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

  constructor(protected container: Container) {}

  /**
   * Register a provider.
   */
  register(
    providerOrClass: ServiceProvider | (new (container: Container) => ServiceProvider)
  ): this {
    const provider =
      providerOrClass instanceof ServiceProvider
        ? providerOrClass
        : new providerOrClass(this.container)

    // Handle deferred providers
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
  registerMany(
    providers: Array<ServiceProvider | (new (container: Container) => ServiceProvider)>
  ): this {
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
  }

  /**
   * Load a deferred provider for a service.
   */
  async loadDeferredProvider(service: string): Promise<void> {
    const provider = this.deferredProviders.get(service)
    if (!provider) return

    if (!this.registered.has(provider)) {
      await provider.register()
      this.registered.add(provider)
      this.providers.push(provider)
    }

    if (!this.booted.has(provider)) {
      await provider.boot?.()
      this.booted.add(provider)
    }

    // Remove from deferred
    for (const providedService of provider.provides()) {
      this.deferredProviders.delete(providedService)
    }
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
