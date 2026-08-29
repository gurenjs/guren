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
  /**
   * Authorization enforced by the chain (RFC 0016 §4): what makes
   * route → ability derivable without reading controller bodies.
   *
   * - `abilities` — the ability names checked, in the order the chain
   *   checks them. Empty when every check derives its ability at request
   *   time (see `resource`).
   * - `mode` — how they combine. `'all'` every listed ability must pass,
   *   `'any'` at least one must. `'mixed'` means the chain carries more
   *   than one check and the conjunction of them is not expressible as
   *   either: authorization is present, but the ability is *not* cleanly
   *   derivable, and a consumer must treat it as undetermined rather than
   *   picking a name out of `abilities`. Note `mode` alone does not say
   *   whether one ability is derivable: `authorizeMiddleware('update')`
   *   reports `'all'` and `authorizeMiddleware(['update'])` reports
   *   `'any'`, and both are equally derivable — key on
   *   `abilities.length === 1`, not on the mode.
   * - `resource` — present when a check resolves its ability from the
   *   request method (`authorizeResourceMiddleware`). `fromMethodMap: true`
   *   means the built-in verb map decides, so a consumer holding the
   *   route's method resolves the ability through
   *   `resourceAbilityForMethod()` in `../../authorization/middleware`.
   *   `false` means an `abilityFor` callback overrides that map and the
   *   real ability is unknowable statically — fail closed, do not fall
   *   back to the verb map.
   */
  authorization?: {
    abilities: string[]
    mode: 'all' | 'any' | 'mixed'
    resource?: { fromMethodMap: boolean }
  }
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
