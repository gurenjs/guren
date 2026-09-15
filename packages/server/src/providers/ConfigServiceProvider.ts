import { ServiceProvider } from '../container/ServiceProvider'
import type { EnvSource } from '../config/env'
import type { Application } from '../http/Application'
import { warnOnce } from '../support/warn-once'

/**
 * Validates `createApp({ env })` and binds the result as `env` (RFC 0027 §1).
 * Registered before every other provider, so validation is the first thing
 * `boot()` does and every later `register()` can read `env`. Not at import: on
 * Workers the values arrive with the first request, bound as `env.source`.
 */
export class ConfigServiceProvider extends ServiceProvider {
  register(): void {
    const schema = this.container.make<Application>('app').envSchema
    if (!schema) return

    const source = this.container.makeOptional<EnvSource>('env.source')
    // RFC 0026's introspection child has no secrets; it reports rather than failing the manifest.
    const introspecting = typeof process !== 'undefined' && process.env.GUREN_INTROSPECT === '1'
    const parsed = schema.parse(source, { mode: introspecting ? 'report' : 'throw' })

    for (const problem of parsed.problems) {
      warnOnce(`env-invalid:${problem.key}`, `[guren] Invalid environment: ${problem.key} ${problem.message} (reported under GUREN_INTROSPECT=1).`)
    }

    this.container.instance('env', parsed.values)
  }
}
