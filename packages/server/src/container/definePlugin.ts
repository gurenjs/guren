import type { Container } from './Container'
import { ServiceProvider, type ServiceProviderConstructor } from './ServiceProvider'

/**
 * A plugin's lifecycle hooks, mirroring the ServiceProvider ones and receiving
 * the configuration captured by the plugin factory.
 */
export interface PluginDefinition<TConfig = void> {
  /** Diagnostic name, also used for the generated provider class name. */
  name: string

  /** Called before any provider has booted. */
  register(container: Container, config: TConfig): void | Promise<void>

  /** Called after all providers have registered. */
  boot?(container: Container, config: TConfig): void | Promise<void>

  /** Defer instantiation until one of `provides` is resolved. */
  deferred?: boolean

  /** Services bound by this plugin; required when `deferred` is true. */
  provides?: string[]
}

/**
 * Each call produces an independent ServiceProvider subclass with the given
 * configuration captured in a closure.
 */
export type PluginFactory<TConfig = void> = (config: TConfig) => ServiceProviderConstructor

/**
 * Define a configurable Guren plugin without ServiceProvider boilerplate. Each
 * factory call returns a fresh provider class, so the same plugin can be
 * registered twice with different configurations.
 */
export function definePlugin<TConfig = void>(
  definition: PluginDefinition<TConfig>,
): PluginFactory<TConfig> {
  const className = `${definition.name}PluginProvider`

  return (config: TConfig) => {
    class ConfiguredPluginProvider extends ServiceProvider {
      static override deferred = definition.deferred ?? false
      static override provides = definition.provides ?? []

      register(): void | Promise<void> {
        return definition.register(this.container, config)
      }

      override boot(): void | Promise<void> {
        return definition.boot?.(this.container, config)
      }
    }

    Object.defineProperty(ConfiguredPluginProvider, 'name', { value: className })
    return ConfiguredPluginProvider
  }
}
