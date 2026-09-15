import { ServiceProvider, type OwnedBinding } from '../container/ServiceProvider'
import type { ConfigDefinition, ConfigDefinitions } from '../config/define'
import type { AppEnv, EnvSource } from '../config/env'
import type { Application } from '../http/Application'
import { warnOnce } from '../support/warn-once'

interface ResolvedDefinition {
  readonly definition: ConfigDefinition
  readonly config: ConfigDefinitions[keyof ConfigDefinitions]
}

/**
 * Validates `createApp({ env })` and binds it as `env`, then resolves and binds
 * each `createApp({ config })` definition (RFC 0027 §1-§3). Registered before
 * every other provider: a bad environment fails the boot before anything
 * registers, every later register() sees the configured managers, and a later
 * provider that rebinds one fails the boot through {@link ownedBindings}.
 */
export class ConfigServiceProvider extends ServiceProvider {
  private env = {} as AppEnv
  private resolved: ResolvedDefinition[] = []
  private owned = new Map<string, OwnedBinding>()

  register(): void {
    const app = this.container.make<Application>('app')
    this.env = this.parseEnv(app)
    this.resolved = []
    this.owned = new Map()

    const definitions = app.configDefinitions
    assertDistinctKeys(definitions)

    for (const definition of definitions) {
      const config = definition.resolve(this.env)
      const before = new Map(this.container.getBindings().map((key) => [key, this.container.bindingOf(key)]))
      definition.bind(this.container, config)

      for (const key of this.container.getBindings()) {
        const binding = this.container.bindingOf(key)
        if (binding !== before.get(key)) {
          this.owned.set(key, { binding, source: `config/${definition.key}.ts` })
        }
      }
      this.resolved.push({ definition, config })
    }
  }

  async boot(): Promise<void> {
    for (const { definition, config } of this.resolved) {
      await definition.boot?.(this.container, config, this.env)
    }
  }

  /** @internal The bindings the definitions made, for ProviderManager's twice-configured check. */
  ownedBindings(): ReadonlyMap<string, OwnedBinding> {
    return this.owned
  }

  private parseEnv(app: Application): AppEnv {
    const schema = app.envSchema
    if (!schema) return {} as AppEnv

    const source = this.container.makeOptional<EnvSource>('env.source')
    // RFC 0026's introspection child has no secrets; it reports rather than failing the manifest.
    const introspecting = typeof process !== 'undefined' && process.env.GUREN_INTROSPECT === '1'
    const parsed = schema.parse(source, { mode: introspecting ? 'report' : 'throw' })

    for (const problem of parsed.problems) {
      warnOnce(`env-invalid:${problem.key}`, `[guren] Invalid environment: ${problem.key} ${problem.message} (reported under GUREN_INTROSPECT=1).`)
    }

    this.container.instance('env', parsed.values)
    return parsed.values as AppEnv
  }
}

function assertDistinctKeys(definitions: ReadonlyArray<ConfigDefinition>): void {
  const seen = new Map<string, number>()
  definitions.forEach((definition, index) => {
    const first = seen.get(definition.key)
    if (first !== undefined) {
      throw new Error(
        `[guren] createApp({ config }) has two "${definition.key}" definitions, at config[${first}] and config[${index}]. Keep one.`,
      )
    }
    seen.set(definition.key, index)
  })
}
