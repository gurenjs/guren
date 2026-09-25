import type { Container } from './Container'
import type { Provider } from './types'
import type { ManifestWarning, ProviderEntry, ProviderSource } from '../introspection/types'

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

  /**
   * Runs in place of `register()` under introspection (RFC 0026 §2). Bind only
   * what the manifest describes; leave anything that connects or reads a runtime
   * binding to `register()`. Absent, introspection runs `register()` unchanged.
   */
  introspect?(): void | Promise<void>

  provides(): string[] {
    return (this.constructor as typeof ServiceProvider).provides
  }

  isDeferred(): boolean {
    return (this.constructor as typeof ServiceProvider).deferred
  }
}

/** A binding a provider made and no later provider may replace, with where it was declared. */
export interface OwnedBinding {
  readonly binding: unknown
  readonly source: string
}

/** Implemented by ConfigServiceProvider: its bindings fail the boot when a later provider replaces one (RFC 0027 §3). */
interface BindingOwner {
  ownedBindings(): ReadonlyMap<string, OwnedBinding>
}

function isBindingOwner(provider: ServiceProvider): provider is ServiceProvider & BindingOwner {
  return typeof (provider as Partial<BindingOwner>).ownedBindings === 'function'
}

/** Implemented by a provider with findings for the manifest, such as ConfigServiceProvider's env problems (RFC 0027 §1). */
interface ManifestWarningSource {
  manifestWarnings(): ReadonlyArray<ManifestWarning>
}

function isManifestWarningSource(provider: ServiceProvider): provider is ServiceProvider & ManifestWarningSource {
  return typeof (provider as Partial<ManifestWarningSource>).manifestWarnings === 'function'
}

/** @internal Where a provider came from, for the manifest's `providers[].source`. */
export interface ProviderOrigin {
  readonly source: ProviderSource
  readonly module?: string
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  private bindingOwners: BindingOwner[] = []
  private allBooted = false
  /** Every provider in registration order, deferred ones included, with where it came from. */
  private readonly origins = new Map<ServiceProvider, ProviderOrigin>()

  constructor(protected container: Container) {}

  /** `origin` is internal: `Application` passes it for the manifest (RFC 0026). */
  register(
    providerOrClass: ServiceProvider | ServiceProviderConstructor,
    origin: ProviderOrigin = { source: 'app.register' },
  ): this {
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

    // An instance registered again adds nothing: its first origin, outcome and warnings stand.
    if (this.origins.has(provider)) return this
    this.origins.set(provider, origin)

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

  /** `origin` is internal, as on {@link register}. */
  registerMany(providers: Array<ServiceProvider | ServiceProviderConstructor>, origin?: ProviderOrigin): this {
    for (const provider of providers) {
      this.register(provider, origin)
    }
    return this
  }

  async registerAll(): Promise<void> {
    for (const provider of this.providers) {
      if (!this.registered.has(provider)) await this.registerOne(provider, () => provider.register())
    }
  }

  private async registerOne(provider: ServiceProvider, run: () => void | Promise<void>): Promise<void> {
    await run()
    // Before marking it registered, so a retried boot runs the check again.
    this.assertOwnedBindingsKept(provider)
    this.registered.add(provider)
    if (isBindingOwner(provider)) this.bindingOwners.push(provider)
  }

  /**
   * @internal `registerAll()` for introspection (RFC 0026 §2): `introspect()` where a
   * provider has one, and a throw is recorded rather than stopping the rest.
   * Deferred providers are reported `skipped`; they register only after boot.
   */
  async registerAllForIntrospection(): Promise<ProviderEntry[]> {
    const outcomes = new Map<ServiceProvider, Pick<ProviderEntry, 'register' | 'error'>>()

    for (const provider of this.providers) {
      if (this.registered.has(provider)) {
        outcomes.set(provider, { register: 'ran' })
        continue
      }

      const hook = provider.introspect
      try {
        await this.registerOne(provider, hook ? () => hook.call(provider) : () => provider.register())
        outcomes.set(provider, { register: hook ? 'introspect-hook' : 'ran' })
      } catch (error) {
        outcomes.set(provider, { register: 'threw', error: describeError(error) })
      }
    }

    return [...this.origins].map(([provider, origin]) => ({
      name: provider.constructor.name,
      source: origin.source,
      ...(origin.module === undefined ? {} : { module: origin.module }),
      deferred: provider.isDeferred(),
      provides: [...provider.provides()],
      ...(outcomes.get(provider) ?? { register: 'skipped' as const }),
    }))
  }

  /** @internal Findings registered providers hold for the manifest, each named after its provider. */
  manifestWarnings(): ManifestWarning[] {
    return this.providers
      .filter((provider) => this.registered.has(provider))
      .filter(isManifestWarningSource)
      .flatMap((provider) =>
        provider.manifestWarnings().map((warning) => ({ ...warning, provider: provider.constructor.name })))
  }

  private assertOwnedBindingsKept(provider: ServiceProvider): void {
    for (const owner of this.bindingOwners) {
      for (const [key, { binding, source }] of owner.ownedBindings()) {
        if (this.container.bindingOf(key) !== binding) {
          throw new Error(`[guren] "${key}" is configured twice: ${source} and ${provider.constructor.name}.register(). Keep one.`)
        }
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
