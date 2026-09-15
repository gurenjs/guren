/**
 * The app's validated environment, as a connection resolver sees it. Empty
 * here: `@guren/orm` cannot depend on `@guren/server`, so `@guren/core`
 * extends it with `AppEnv` (RFC 0027 §2).
 */
// oxlint-disable-next-line typescript/no-empty-object-type -- an augmentation target, filled by @guren/core
export interface OrmConnectionEnv {}

/** What `configureOrm(context)` hands every later resolution of a connection setting. */
export interface ConnectionContext {
  readonly env: OrmConnectionEnv
}

/**
 * A connection setting, or a function of the context the factory last received
 * through `configureOrm(context)`; `undefined` outside an application. A result
 * of `undefined` falls back to the driver's environment variable.
 */
export type ConnectionResolver = string | ((context?: ConnectionContext) => string | undefined)

export interface ConnectionSettings {
  resolve(value: ConnectionResolver | undefined): string | undefined
  /**
   * Keeps `context` for every later `resolve()`. True when a setting already
   * resolved now resolves differently: the handle and the migrations opened
   * against the old value name the wrong database and must be dropped.
   */
  remember(context: ConnectionContext | undefined): boolean
}

/**
 * One per factory. The context is kept rather than passed, because resolutions
 * also run inside memoized flights and admin clients that no `configureOrm()`
 * call reaches.
 */
export function connectionSettings(): ConnectionSettings {
  let kept: ConnectionContext | undefined
  const resolved = new Map<Exclude<ConnectionResolver, string>, string | undefined>()

  return {
    resolve(value) {
      if (typeof value !== 'function') return value
      const result = value(kept)
      resolved.set(value, result)
      return result
    },
    remember(context) {
      if (!context || context === kept) return false
      kept = context
      const stale = [...resolved].some(([resolver, previous]) => resolver(context) !== previous)
      resolved.clear()
      return stale
    },
  }
}
