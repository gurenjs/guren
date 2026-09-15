/**
 * Which environment keys a definition's `resolve()` read (RFC 0027 §2).
 * ConfigServiceProvider leaves a definition unbound when it read a key the
 * environment does not set, rather than handing a manager the redacted
 * placeholder; the CLI reads the same record to know which config it may trust.
 */
export interface RecordedEnv<T> {
  readonly env: T
  /** Filled while `resolve()` runs, so read it after the call. */
  readonly read: ReadonlySet<string>
}

export function recordEnvReads<T extends object>(values: T): RecordedEnv<T> {
  const read = new Set<string>()
  const env = new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === 'string') read.add(property)
      return Reflect.get(target, property, receiver)
    },
  })

  return { env, read }
}
