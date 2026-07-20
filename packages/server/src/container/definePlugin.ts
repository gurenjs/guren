import type { Container } from './Container'
import { ServiceProvider, type ServiceProviderConstructor } from './ServiceProvider'

/**
 * Declarative definition of a plugin's lifecycle hooks.
 *
 * `register` and `boot` mirror the ServiceProvider hooks and receive the
 * container plus the configuration captured by the plugin factory.
 */
export interface PluginDefinition<TConfig = void> {
  /**
   * Diagnostic name for the plugin (e.g. 'analytics').
   * Used to derive the generated provider class name.
   */
  name: string

  /**
   * Register services into the container.
   * Called before any provider has booted.
   */
  register(container: Container, config: TConfig): void | Promise<void>

  /**
   * Bootstrap after all providers have registered.
   */
  boot?(container: Container, config: TConfig): void | Promise<void>

  /**
   * Defer instantiation until one of the `provides` services is resolved.
   * Maps to `ServiceProvider.deferred`.
   */
  deferred?: boolean

  /**
   * Services bound by this plugin (required when `deferred` is true).
   * Maps to `ServiceProvider.provides`.
   */
  provides?: string[]
}

/**
 * A factory returned by `definePlugin()`. Each call produces an independent
 * ServiceProvider subclass with the given configuration captured in a closure.
 */
export type PluginFactory<TConfig = void> = (config: TConfig) => ServiceProviderConstructor

/**
 * Define a configurable Guren plugin without ServiceProvider boilerplate.
 *
 * Unlike storing configuration on a static class property, each factory call
 * returns a fresh provider class, so the same plugin can be registered twice
 * with different configurations.
 *
 * @example
 * ```typescript
 * export const analyticsPlugin = definePlugin<AnalyticsConfig>({
 *   name: 'analytics',
 *   register(container, config) {
 *     container.singleton('analytics', () => new AnalyticsClient(config))
 *   },
 * })
 *
 * // In the application:
 * createApp({
 *   providers: [analyticsPlugin({ apiKey: process.env.ANALYTICS_API_KEY! })],
 * })
 * ```
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
