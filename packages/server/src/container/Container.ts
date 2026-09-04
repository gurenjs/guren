import type {
  ServiceFactory,
  ServiceBinding,
  ContextualBindingBuilder,
  ContextualNeedsBuilder,
  ContextualBinding,
} from './types'
import type { ServiceBindings } from './bindings'

/**
 * Dependency injection container. Keys from `ServiceBindings` type `make()`
 * automatically; other keys take an explicit type parameter (`make<T>(key)`).
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
   * Called from make() for an unbound key; must run the deferred provider's
   * register() synchronously before returning (boot() may settle on the returned
   * promise). `undefined` means no deferred provider claims the service.
   */
  deferredProviderLoader: ((service: string) => Promise<void> | undefined) | null = null

  /** Bind a factory; each resolution creates a new instance. */
  bind<T>(key: string, factory: ServiceFactory<T>): this {
    this.bindings.set(key, {
      factory,
      singleton: false,
    })
    return this
  }

  /** Bind a factory whose single instance is reused. */
  singleton<T>(key: string, factory: ServiceFactory<T>): this {
    this.bindings.set(key, {
      factory,
      singleton: true,
    })
    return this
  }

  instance<T>(key: string, value: T): this {
    this.bindings.set(key, {
      factory: () => value,
      singleton: true,
      instance: value,
    })
    return this
  }

  make<K extends keyof ServiceBindings>(key: K): ServiceBindings[K]
  make<T>(key: string): T
  make(key: string): unknown {
    if (this.fakes.has(key)) {
      return this.fakes.get(key)
    }

    const resolvedKey = this.resolveAlias(key)

    if (resolvedKey !== key && this.fakes.has(resolvedKey)) {
      return this.fakes.get(resolvedKey)
    }

    // make() is synchronous, so it only sees what the provider's register() bound
    // before the loader returned; an async register() binds too late and is
    // reported rather than surfacing as a bare "not found".
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

    if (binding.singleton && binding.instance !== undefined) {
      return binding.instance
    }

    if (this.scopedInstances.length > 0) {
      const currentScope = this.scopedInstances[this.scopedInstances.length - 1]
      if (currentScope.has(resolvedKey)) {
        return currentScope.get(resolvedKey)
      }
    }

    const contextualFactory = this.findContextualBinding(resolvedKey)

    this.resolvingStack.push(resolvedKey)

    try {
      const factory = contextualFactory ?? binding.factory
      const instance = factory(this)

      if (binding.singleton) {
        binding.instance = instance
      }

      if (this.scopedInstances.length > 0 && !binding.singleton) {
        const currentScope = this.scopedInstances[this.scopedInstances.length - 1]
        currentScope.set(resolvedKey, instance)
      }

      return instance
    } finally {
      this.resolvingStack.pop()
    }
  }

  makeWith<T>(key: string, params: Record<string, unknown>): T {
    const resolvedKey = this.resolveAlias(key)
    const binding = this.bindings.get(resolvedKey)

    if (!binding) {
      throw new Error(`Service "${key}" not found in container`)
    }

    const tempContainer = new Container()

    for (const [k, v] of this.bindings) {
      tempContainer.bindings.set(k, { ...v })
    }

    for (const [paramKey, paramValue] of Object.entries(params)) {
      tempContainer.instance(paramKey, paramValue)
    }

    return binding.factory(tempContainer) as T
  }

  has(key: string): boolean {
    const resolvedKey = this.resolveAlias(key)
    return this.bindings.has(resolvedKey)
  }

  alias(alias: string, key: string): this {
    if (alias === key) {
      throw new Error('Alias cannot be the same as the key')
    }
    this.aliases.set(alias, key)
    return this
  }

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

  tagged<T = unknown>(tagName: string): T[] {
    const taggedKeys = this.tags.get(tagName)
    if (!taggedKeys) {
      return []
    }

    return Array.from(taggedKeys).map((key) => this.make<T>(key))
  }

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

  /** Services resolved inside the callback are cached for the scope and released when it ends. */
  scoped<T>(callback: () => T): T {
    this.scopedInstances.push(new Map())

    try {
      return callback()
    } finally {
      this.scopedInstances.pop()
    }
  }

  async scopedAsync<T>(callback: () => Promise<T>): Promise<T> {
    this.scopedInstances.push(new Map())

    try {
      return await callback()
    } finally {
      this.scopedInstances.pop()
    }
  }

  /**
   * Replace a binding with a fake for tests; the returned disposable restores the
   * original (`using _ = container.fake(key, fake)`).
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

  isFaked(key: string): boolean {
    return this.fakes.has(key)
  }

  clearFakes(): void {
    this.fakes.clear()
  }

  flush(): void {
    for (const binding of this.bindings.values()) {
      binding.instance = undefined
    }
  }

  forget(key: string): this {
    const resolvedKey = this.resolveAlias(key)
    this.bindings.delete(resolvedKey)
    return this
  }

  getBindings(): string[] {
    return Array.from(this.bindings.keys())
  }

  getAliases(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [alias, key] of this.aliases) {
      result[alias] = key
    }
    return result
  }

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

export function createContainer(): Container {
  return new Container()
}

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
