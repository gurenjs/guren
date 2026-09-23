import { ServiceProvider, type OwnedBinding } from '../container/ServiceProvider'
import type { ConfigDefinition, ConfigDefinitions } from '../config/define'
import type { AppEnv, EnvSource } from '../config/env'
import { recordEnvReads } from '../config/env-reads'
import type { Application, ConfiguredDefinition } from '../http/Application'
import { warnOnce } from '../support/warn-once'

interface ResolvedDefinition {
  readonly definition: ConfigDefinition
  readonly config: ConfigDefinitions[keyof ConfigDefinitions]
}

/**
 * Validates `createApp({ env })` and binds it as `env`, then resolves and binds
 * each `createApp({ config })` definition and each module's `config` after them
 * (RFC 0027 §1-§3, RFC 0002). Registered before
 * every other provider: a bad environment fails the boot before anything
 * registers, every later register() sees the configured managers, and a later
 * provider that rebinds one fails the boot through {@link ownedBindings}.
 */
export class ConfigServiceProvider extends ServiceProvider {
  private env = {} as AppEnv
  private unset: ReadonlySet<string> = new Set()
  private resolved: ResolvedDefinition[] = []
  private owned = new Map<string, OwnedBinding>()

  register(): void {
    const app = this.container.make<Application>('app')
    this.env = this.parseEnv(app)
    this.resolved = []
    this.owned = new Map()

    const entries = app.configEntries
    assertDistinctKeys(entries)

    for (const entry of entries) {
      const { definition } = entry
      const { env, read } = recordEnvReads(this.env)
      const config = definition.resolve(env)

      // Reachable only where parsing reported rather than threw, which today is
      // GUREN_INTROSPECT=1. Binding would hand the redacted placeholder to a
      // manager constructor that validates it; nothing bound answers 503 instead.
      const placeholders = [...read].filter((key) => this.unset.has(key))
      if (placeholders.length > 0) {
        warnOnce(
          `config-unverified:${definition.key}`,
          `[guren] the "${definition.key}" config reads ${placeholders.join(', ')}, which the environment does not set; it was left unbound.`,
        )
        continue
      }

      const before = new Map(this.container.getBindings().map((key) => [key, this.container.bindingOf(key)]))
      definition.bind(this.container, config)

      for (const key of this.container.getBindings()) {
        const binding = this.container.bindingOf(key)
        if (binding !== before.get(key)) {
          this.owned.set(key, { binding, source: `${entry.module === undefined ? '' : `modules/${entry.module}/`}config/${definition.key}.ts` })
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
    this.unset = new Set()
    if (!schema) return {} as AppEnv

    const source = this.container.makeOptional<EnvSource>('env.source')
    // RFC 0026's introspection child has no secrets; it reports rather than failing the manifest.
    const introspecting = typeof process !== 'undefined' && process.env.GUREN_INTROSPECT === '1'
    const parsed = schema.parse(source, { mode: introspecting ? 'report' : 'throw' })

    for (const problem of parsed.problems) {
      warnOnce(`env-invalid:${problem.key}`, `[guren] Invalid environment: ${problem.key} ${problem.message} (reported under GUREN_INTROSPECT=1).`)
    }

    this.unset = parsed.unset
    this.container.instance('env', parsed.values)
    return parsed.values as AppEnv
  }
}

function assertDistinctKeys(entries: ReadonlyArray<ConfiguredDefinition>): void {
  const seen = new Map<string, ConfiguredDefinition>()
  for (const entry of entries) {
    const first = seen.get(entry.definition.key)
    if (first !== undefined) {
      throw new Error(
        `[guren] "${entry.definition.key}" has two config definitions, at ${listedAt(first)} and ${listedAt(entry)}. Keep one.`,
      )
    }
    seen.set(entry.definition.key, entry)
  }
}

function listedAt(entry: ConfiguredDefinition): string {
  return entry.module === undefined
    ? `createApp({ config })[${entry.index}]`
    : `the "${entry.module}" module's config[${entry.index}]`
}
