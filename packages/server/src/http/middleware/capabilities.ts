import type { MiddlewareHandler } from 'hono'

/**
 * Internal security-capability marker (RFC 0007).
 *
 * Built-in middleware factories stamp the handlers they return so tooling
 * that holds the real function objects (the router registry, `guren audit`
 * via route loading) can recognize what a handler enforces without name
 * heuristics. `Symbol.for()` keeps the key identical across duplicated
 * `@guren/server` copies in one process.
 *
 * Deliberately not part of the public API: nothing here is exported from
 * the package root, and the shape may change in any release. A public
 * `defineMiddleware` integration is future work in RFC 0007.
 */
export const CAPABILITIES = Symbol.for('guren.capabilities')

export interface MiddlewareCapabilities {
  authentication?: { mode: 'required' | 'guest-only' }
}

export function stampCapabilities(
  handler: MiddlewareHandler,
  capabilities: MiddlewareCapabilities,
): MiddlewareHandler {
  Object.defineProperty(handler, CAPABILITIES, { value: capabilities, enumerable: false })
  return handler
}

export function capabilitiesOf(handler: unknown): MiddlewareCapabilities | undefined {
  if (typeof handler !== 'function') return undefined
  return (handler as { [CAPABILITIES]?: MiddlewareCapabilities })[CAPABILITIES]
}
