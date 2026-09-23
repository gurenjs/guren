/** Set by the CLI's introspection child before the app's module graph evaluates (RFC 0026 §2). */
const INTROSPECT_ENV_FLAG = 'GUREN_INTROSPECT'

/** `code` on the error `listen()` throws under the flag; read by duck-typing, since the reader may load another server copy. */
const INTROSPECT_LISTEN_REFUSED = 'GUREN_INTROSPECT_LISTEN'

/** Whether this process is an introspection run. The one reader of the flag. */
export function isIntrospecting(): boolean {
  return typeof process !== 'undefined' && process.env?.[INTROSPECT_ENV_FLAG] === '1'
}

/** `listen()` under the flag: an introspection run must never open a socket. */
export class IntrospectionListenError extends Error {
  readonly code = INTROSPECT_LISTEN_REFUSED

  constructor() {
    super(
      `Cannot listen under ${INTROSPECT_ENV_FLAG}=1: introspection registers providers and mounts routes, and never serves. `
        + 'Unset the variable to serve the app.',
    )
    this.name = 'IntrospectionListenError'
  }
}
