import type { MiddlewareHandler } from 'hono'

/**
 * Internal security-capability marker (RFC 0007): built-in middleware
 * factories stamp their handlers so tooling can read what a chain enforces
 * without name heuristics. `Symbol.for()` keeps the key identical across
 * duplicated `@guren/server` copies in one process. Not public API — the
 * shape may change in any release.
 */
export const CAPABILITIES = Symbol.for('guren.capabilities')

export interface MiddlewareCapabilities {
  /**
   * Authentication enforced by the chain. `'required'` beats `'guest-only'`
   * when a chain somehow carries both.
   */
  authentication?: { mode: 'required' | 'guest-only' }
  /**
   * Authorization enforced by the chain (RFC 0016 §4): what makes
   * route → ability derivable without reading controller bodies.
   */
  authorization?: {
    /**
     * In check order. Empty when the ability is resolved at request time
     * (see `resource`), and for `authorizeMiddleware([])`, which denies all.
     */
    abilities: string[]
    /**
     * A single ability normalizes to `'all'`, so `'any'` means two or more
     * alternatives (or the empty deny-all list). `'mixed'` means several
     * checks whose conjunction is neither: authorization is present but the
     * ability is *not* derivable — treat it as undetermined rather than
     * reading a name out of `abilities`.
     */
    mode: 'all' | 'any' | 'mixed'
    /**
     * Present when a check resolves its ability from the request method.
     * `fromMethodMap` → resolve through `resourceAbilityForMethod()` in
     * `../../authorization/middleware`; otherwise an `abilityFor` callback
     * overrides the verb map and the ability is statically unknowable, so
     * fail closed rather than falling back to it.
     */
    resource?: { fromMethodMap: boolean }
  }
}

/**
 * Folds one middleware's stamp into an accumulating aggregate. Mutates `into`
 * and never `stamp`. Every call counts as an independent check, so folding the
 * *same* stamp twice degrades an `'any'` to `'mixed'` — de-duplicating handlers
 * that appear more than once in a chain is the caller's job.
 */
export function mergeCapabilities(
  into: MiddlewareCapabilities,
  stamp: MiddlewareCapabilities,
): void {
  const auth = stamp.authentication
  if (auth && (!into.authentication || auth.mode === 'required')) {
    into.authentication = { ...auth }
  }

  const authz = stamp.authorization
  if (!authz) return

  const current = into.authorization
  if (!current) {
    into.authorization = {
      abilities: [...authz.abilities],
      mode: authz.mode,
      ...(authz.resource ? { resource: { ...authz.resource } } : {}),
    }
    return
  }

  for (const ability of authz.abilities) {
    if (!current.abilities.includes(ability)) current.abilities.push(ability)
  }

  current.mode = current.mode === 'all' && authz.mode === 'all' ? 'all' : 'mixed'

  if (authz.resource) {
    current.resource = {
      fromMethodMap: (current.resource?.fromMethodMap ?? true) && authz.resource.fromMethodMap,
    }
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
