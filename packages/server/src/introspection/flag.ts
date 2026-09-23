// workerd provides the module under `nodejs_compat`, as for `request-deferrer.ts`.
import { AsyncLocalStorage } from 'node:async_hooks'

/** Set by the CLI's introspection child before the app's module graph evaluates (RFC 0026 §2). */
const INTROSPECT_ENV_FLAG = 'GUREN_INTROSPECT'

/** `code` on the error `listen()` throws under the flag; read by duck-typing, since the reader may load another server copy. */
const INTROSPECT_LISTEN_REFUSED = 'GUREN_INTROSPECT_LISTEN'

/** Entered around an in-process `Application.introspect()`, so only that run's async work sees it. */
const scope = new AsyncLocalStorage<true>()

/**
 * Whether this code runs for an introspection: the CLI child's `GUREN_INTROSPECT=1`,
 * or inside an `Application.introspect()` in this process. The one reader of both.
 */
export function isIntrospecting(): boolean {
  return scope.getStore() === true || (typeof process !== 'undefined' && process.env?.[INTROSPECT_ENV_FLAG] === '1')
}

/** Runs `fn` with {@link isIntrospecting} true for it and everything it schedules, timers that outlive it included. */
export function runIntrospecting<T>(fn: () => T): T {
  return scope.run(true, fn)
}

/** `listen()` under the flag: an introspection run must never open a socket. */
export class IntrospectionListenError extends Error {
  readonly code = INTROSPECT_LISTEN_REFUSED

  constructor() {
    super(
      `Cannot listen under ${INTROSPECT_ENV_FLAG}=1: introspection registers providers and routes, and never serves. `
        + 'Unset the variable to serve the app.',
    )
    this.name = 'IntrospectionListenError'
  }
}
