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
