import type {
  ServiceFactory,
  ServiceBinding,
  ContextualBindingBuilder,
  ContextualNeedsBuilder,
  ContextualBinding,
} from './types'
import type { ServiceBindings } from './bindings'

/**
 * Dependency injection container with type-safe service resolution.
 *
 * @example
 * ```typescript
 * const container = new Container()
 *
 * // Register services
 * container.singleton('events', (c) => new EventManager())
 * container.instance('config', loadConfig())
 *
 * // Type-safe resolution (known bindings)
 * const events = container.make('events') // EventManager
 *
 * // Generic resolution (custom bindings)
 * const db = container.make<Database>('db')
 * ```
 */
export class Container {
  protected bindings: Map<string, ServiceBinding> = new Map()
  protected aliases: Map<string, string> = new Map()
  protected tags: Map<string, Set<string>> = new Map()
  protected contextualBindings: ContextualBinding[] = []
  protected resolvingStack: string[] = []
  protected scopedInstances: Map<string, unknown>[] = []
  protected fakes: Map<string, unknown> = new Map()

  /**
   * @internal Installed by ProviderManager once every eager provider has booted.
   *
   * Called from `make()` for a key with no binding. The loader must run the
   * deferred provider's `register()` *synchronously* before it returns, so the
   * bindings it adds are visible to the same `make()` call; `boot()` may be
   * asynchronous and is what the returned promise settles on. `undefined`
   * means no deferred provider claims the service.
   */
  deferredProviderLoader: ((service: string) => Promise<void> | undefined) | null = null

  /**
   * Bind a service to the container.
   * Each resolution creates a new instance.
   */
  bind<T>(key: string, factory: ServiceFactory<T>): this {
    this.bindings.set(key, {
      factory,
      singleton: false,
    })
    return this
  }

  /**
   * Bind a singleton service to the container.
   * Only one instance is created and reused.
   */
  singleton<T>(key: string, factory: ServiceFactory<T>): this {
    this.bindings.set(key, {
      factory,
      singleton: true,
    })
    return this
  }

  /**
   * Bind an existing instance to the container.
   */
  instance<T>(key: string, value: T): this {
    this.bindings.set(key, {
      factory: () => value,
      singleton: true,
      instance: value,
    })
    return this
  }

  /**
   * Resolve a service from the container.
   *
   * Known service keys (from ServiceBindings) are automatically typed:
   * ```typescript
   * container.make('events') // EventManager
   * container.make('cache')  // CacheManager
   * ```
   *
   * Custom keys require an explicit type parameter:
   * ```typescript
   * container.make<MyService>('myService')
   * ```
   */
  make<K extends keyof ServiceBindings>(key: K): ServiceBindings[K]
  make<T>(key: string): T
  make(key: string): unknown {
    // Check fakes first (for testing)
    if (this.fakes.has(key)) {
      return this.fakes.get(key)
    }

    // Resolve alias
    const resolvedKey = this.resolveAlias(key)

    // Check fakes for resolved alias too
    if (resolvedKey !== key && this.fakes.has(resolvedKey)) {
      return this.fakes.get(resolvedKey)
    }

    // Check binding exists — try deferred providers if not found.
    // make() is synchronous, so it can only see what the provider's register()
    // bound before the loader returned; the loader contract guarantees that
    // for a synchronous register(). An async register() binds too late for
    // this call, which is reported rather than left as a bare "not found".
    let binding = this.bindings.get(resolvedKey)
    if (!binding && this.deferredProviderLoader) {
      const loading = this.deferredProviderLoader(resolvedKey)
      binding = this.bindings.get(resolvedKey)
      if (loading && !binding) {
        throw new Error(
          `Deferred provider for "${key}" did not bind "${resolvedKey}" synchronously in register(). ` +
          'Container.make() cannot await an async register(); bind the service synchronously, ' +
          'or await ProviderManager.loadDeferredProvider() before resolving it.',
        )
      }
    }
    if (!binding) {
      throw new Error(`Service "${key}" not found in container`)
    }

    // Return existing singleton instance
    if (binding.singleton && binding.instance !== undefined) {
      return binding.instance
    }

    // Check scoped instances
    if (this.scopedInstances.length > 0) {
      const currentScope = this.scopedInstances[this.scopedInstances.length - 1]
      if (currentScope.has(resolvedKey)) {
        return currentScope.get(resolvedKey)
      }
    }

    // Check contextual binding
    const contextualFactory = this.findContextualBinding(resolvedKey)

    // Push to resolving stack
    this.resolvingStack.push(resolvedKey)

    try {
      // Resolve instance
      const factory = contextualFactory ?? binding.factory
      const instance = factory(this)

      // Store singleton instance
      if (binding.singleton) {
        binding.instance = instance
      }

      // Store in scope if active
      if (this.scopedInstances.length > 0 && !binding.singleton) {
        const currentScope = this.scopedInstances[this.scopedInstances.length - 1]
        currentScope.set(resolvedKey, instance)
      }

      return instance
    } finally {
      this.resolvingStack.pop()
    }
  }

  /**
   * Resolve a service with additional parameters.
   */
  makeWith<T>(key: string, params: Record<string, unknown>): T {
    const resolvedKey = this.resolveAlias(key)
    const binding = this.bindings.get(resolvedKey)

    if (!binding) {
      throw new Error(`Service "${key}" not found in container`)
    }

    // Create a temporary container with params
    const tempContainer = new Container()

    // Copy all bindings
    for (const [k, v] of this.bindings) {
      tempContainer.bindings.set(k, { ...v })
    }

    // Add params as instances
    for (const [paramKey, paramValue] of Object.entries(params)) {
      tempContainer.instance(paramKey, paramValue)
    }

    return binding.factory(tempContainer) as T
  }

  /**
   * Check if a service is bound in the container.
   */
  has(key: string): boolean {
    const resolvedKey = this.resolveAlias(key)
    return this.bindings.has(resolvedKey)
  }

  /**
   * Create an alias for a service.
   */
  alias(alias: string, key: string): this {
    if (alias === key) {
      throw new Error('Alias cannot be the same as the key')
    }
    this.aliases.set(alias, key)
    return this
  }

  /**
   * Tag multiple services with a tag name.
   */
  tag(keys: string[], tagName: string): this {
    let taggedKeys = this.tags.get(tagName)
    if (!taggedKeys) {
      taggedKeys = new Set()
      this.tags.set(tagName, taggedKeys)
    }

    for (const key of keys) {
      taggedKeys.add(key)
    }

    return this
  }

  /**
   * Resolve all services with a given tag.
   */
  tagged<T = unknown>(tagName: string): T[] {
    const taggedKeys = this.tags.get(tagName)
    if (!taggedKeys) {
      return []
    }

    return Array.from(taggedKeys).map((key) => this.make<T>(key))
  }

  /**
   * Define a contextual binding.
   */
  when(concrete: string): ContextualBindingBuilder {
    return {
      needs: (abstract: string): ContextualNeedsBuilder => {
        return {
          give: <T>(factoryOrValue: ServiceFactory<T> | T): void => {
            const factory =
              typeof factoryOrValue === 'function'
                ? (factoryOrValue as ServiceFactory<T>)
                : () => factoryOrValue

            this.contextualBindings.push({
              concrete,
              needs: abstract,
              factory: factory as ServiceFactory<unknown>,
            })
          },
        }
      },
    }
  }

  /**
   * Run a callback within a scoped context.
   * Services resolved within the scope are cached and released when the scope ends.
   */
  scoped<T>(callback: () => T): T {
    this.scopedInstances.push(new Map())

    try {
      return callback()
    } finally {
      this.scopedInstances.pop()
    }
  }

  /**
   * Run an async callback within a scoped context.
   */
  async scopedAsync<T>(callback: () => Promise<T>): Promise<T> {
    this.scopedInstances.push(new Map())

    try {
      return await callback()
    } finally {
      this.scopedInstances.pop()
    }
  }

  /**
   * Replace a service binding with a fake instance for testing.
   * Returns a disposable that restores the original binding when disposed.
   *
   * @example
   * ```typescript
   * // Using 'using' declaration (auto-cleanup)
   * using _ = container.fake('events', fakeEventManager)
   *
   * // Manual cleanup
   * const restore = container.fake('mail', fakeMailManager)
   * // ... run tests ...
   * restore[Symbol.dispose]()
   * ```
   */
  fake<K extends keyof ServiceBindings>(key: K, instance: ServiceBindings[K]): Disposable
  fake(key: string, instance: unknown): Disposable
  fake(key: string, instance: unknown): Disposable {
    this.fakes.set(key, instance)
    return {
      [Symbol.dispose]: () => {
        this.fakes.delete(key)
      },
    }
  }

  /**
   * Check if a service is currently faked.
   */
  isFaked(key: string): boolean {
    return this.fakes.has(key)
  }

  /**
   * Remove all fakes.
   */
  clearFakes(): void {
    this.fakes.clear()
  }

  /**
   * Flush all resolved singleton instances.
   */
  flush(): void {
    for (const binding of this.bindings.values()) {
      binding.instance = undefined
    }
  }

  /**
   * Remove a binding from the container.
   */
  forget(key: string): this {
    const resolvedKey = this.resolveAlias(key)
    this.bindings.delete(resolvedKey)
    return this
  }

  /**
   * Get all bound service keys.
   */
  getBindings(): string[] {
    return Array.from(this.bindings.keys())
  }

  /**
   * Get all aliases.
   */
  getAliases(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [alias, key] of this.aliases) {
      result[alias] = key
    }
    return result
  }

  /**
   * Get all tags.
   */
  getTags(): Record<string, string[]> {
    const result: Record<string, string[]> = {}
    for (const [tag, keys] of this.tags) {
      result[tag] = Array.from(keys)
    }
    return result
  }

  protected resolveAlias(key: string): string {
    let resolved = key
    const seen = new Set<string>()

    while (this.aliases.has(resolved)) {
      if (seen.has(resolved)) {
        throw new Error(`Circular alias detected: ${key}`)
      }
      seen.add(resolved)
      resolved = this.aliases.get(resolved)!
    }

    return resolved
  }

  protected findContextualBinding(needs: string): ServiceFactory<unknown> | null {
    if (this.resolvingStack.length === 0) {
      return null
    }

    const currentConcrete = this.resolvingStack[this.resolvingStack.length - 1]

    for (const binding of this.contextualBindings) {
      if (binding.concrete === currentConcrete && binding.needs === needs) {
        return binding.factory
      }
    }

    return null
  }
}

/**
 * Create a new container instance.
 */
export function createContainer(): Container {
  return new Container()
}

// ---------------------------------------------------------------------------
// Global container singleton
// ---------------------------------------------------------------------------

let globalContainer: Container | null = null

export function setContainer(container: Container): void {
  globalContainer = container
}

export function getContainer(): Container {
  if (!globalContainer) {
    throw new Error('Container not initialized. Call setContainer() first.')
  }
  return globalContainer
}

export function resolve<T = unknown>(key: string): T {
  return getContainer().make<T>(key)
}
