import type { Container } from './Container'
import type { Provider } from './types'

/**
 * Constructor shape accepted wherever a provider class can be registered.
 */
export type ServiceProviderConstructor = new (container: Container) => ServiceProvider

/**
 * Base service provider: all application and core bootstrapping runs through
 * providers. `register()` binds services before any provider boots; `boot()` runs
 * after every provider has registered.
 */
export abstract class ServiceProvider implements Provider {
  /** Load only when one of `provides` is requested. */
  static deferred: boolean = false

  /** Services this provider supplies, for deferred loading. */
  static provides: string[] = []

  constructor(protected container: Container) {}

  /** Runs before any provider has booted. */
  abstract register(): void | Promise<void>

  /** Runs after all providers have registered. */
  boot?(): void | Promise<void>

  provides(): string[] {
    return (this.constructor as typeof ServiceProvider).provides
  }

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

  registerMany(providers: Array<ServiceProvider | ServiceProviderConstructor>): this {
    for (const provider of providers) {
      this.register(provider)
    }
    return this
  }

  async registerAll(): Promise<void> {
    for (const provider of this.providers) {
      if (!this.registered.has(provider)) {
        await provider.register()
        this.registered.add(provider)
      }
    }
  }

  async bootAll(): Promise<void> {
    for (const provider of this.providers) {
      if (!this.booted.has(provider) && this.registered.has(provider)) {
        await provider.boot?.()
        this.booted.add(provider)
      }
    }
    this.allBooted = true

    if (this.deferredProviders.size > 0) {
      this.container.deferredProviderLoader = (service: string) =>
        this.activateDeferredProvider(service)
    }
  }

  /**
   * Register, boot, and unclaim a deferred provider's services. Resolves once
   * boot() has finished, also when Container.make() already activated it.
   */
  async loadDeferredProvider(service: string): Promise<void> {
    await (this.activateDeferredProvider(service) ?? this.deferredActivations.get(service))
  }

  /**
   * Synchronous half of deferred loading, so a synchronous Container.make() can
   * resolve the service: register() runs before this returns; boot() follows on the
   * returned promise, which make() does not await (a boot failure is an unhandled
   * rejection). Services are unclaimed up front so a re-entrant make() for a sibling
   * service cannot register the provider twice.
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

  isDeferredService(service: string): boolean {
    return this.deferredProviders.has(service)
  }

  getProviders(): ServiceProvider[] {
    return [...this.providers]
  }

  getDeferredServices(): string[] {
    return Array.from(this.deferredProviders.keys())
  }
}
