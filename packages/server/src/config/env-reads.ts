/**
 * Which environment keys a definition's `resolve()` read (RFC 0027 §2).
 * ConfigServiceProvider leaves a definition unbound when it read a key the
 * environment does not set, rather than handing a manager the redacted
 * placeholder; the CLI reads the same record to know which key selected a store.
 */
import type { AppEnv } from './env'

export interface RecordedEnv {
  readonly env: AppEnv
  /** Filled while `resolve()` runs, so read it after the call. */
  readonly read: ReadonlySet<string>
}

export function recordEnvReads(values: AppEnv): RecordedEnv {
  const read = new Set<string>()
  const env = new Proxy(values as Record<string, unknown>, {
    get(target, property, receiver) {
      if (typeof property === 'string') read.add(property)
      return Reflect.get(target, property, receiver)
    },
  }) as AppEnv

  return { env, read }
}
