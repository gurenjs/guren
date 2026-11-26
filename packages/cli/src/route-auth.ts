/**
 * Whether a route requires a signed-in user, read from its resolved middleware in the
 * introspected app (RFC 0026 §5): the one rule `guren audit`'s authentication finding and
 * the navigation's sign-in reading judge a route by.
 */
import type { MiddlewareEntry, RouteEntry } from '@guren/server'

/** A name that reads as authentication, judged only where no capability says so. */
export const AUTH_MIDDLEWARE_PATTERN = /auth/i

export type AuthMiddlewareVerdict =
  /** A middleware in the chain carries the framework's authentication capability. */
  | 'verified'
  /** Old server without capability support; a middleware *name* matched /auth/i. */
  | 'legacy-name-match'
  /** Capabilities are supported, no guard found, but a name looks auth-like. */
  | 'unverified-auth-name'
  /**
   * Manifest only: the chain authorizes but requires no authentication. Not a pass: a guest
   * request reaches the gate with a null user, and a policy may allow it.
   */
  | 'authorization-only'
  /** No authentication middleware detected by any signal. */
  | 'none'

/** A verdict and what it names: the auth-like aliases, or each authorizing entry's check. */
export interface RouteAuthVerdict {
  verdict: AuthMiddlewareVerdict
  names: string[]
  /** Manifest only: the names no alias or group registers anywhere in the app. */
  unresolved: string[]
}

/**
 * The authentication verdict from a route's resolved middleware (RFC 0026 §5), aliases and
 * groups expanded by the app that registered them. The auth-like name match applies to named
 * aliases and groups only, as on the static path; an inline handler's name is its function's.
 */
export function manifestAuthVerdict(route: Pick<RouteEntry, 'middleware'>): RouteAuthVerdict {
  const { middleware } = route
  const unresolved = middleware.flatMap((entry) =>
    entry.unresolved ? [entry.name ?? ''] : (entry.unresolvedMembers ?? []))
  if (middleware.some((entry) => entry.capabilities.authentication?.mode === 'required')) return { verdict: 'verified', names: [], unresolved }

  const named = middleware.flatMap((entry) =>
    entry.kind !== 'inline' && !entry.capabilities.authorization && entry.name && AUTH_MIDDLEWARE_PATTERN.test(entry.name) ? [entry.name] : [])
  if (named.length > 0) return { verdict: 'unverified-auth-name', names: named, unresolved }

  const authorizing = middleware.flatMap((entry) => {
    const authorization = entry.capabilities.authorization
    return authorization ? [describeAuthorization(authorization, entry.ability)] : []
  })
  if (authorizing.length > 0) return { verdict: 'authorization-only', names: authorizing, unresolved }
  return { verdict: 'none', names: [], unresolved }
}

/** What one authorizing entry checks, in words: `ability` is present only when it is derivable. */
function describeAuthorization(authorization: NonNullable<MiddlewareEntry['capabilities']['authorization']>, ability: string | undefined): string {
  if (ability !== undefined) return `ability '${ability}'`
  if (authorization.resource) return 'an ability decided at request time'
  if (authorization.abilities.length === 0) return 'a check that denies every request'
  const abilities = authorization.abilities.map((name) => `'${name}'`).join(', ')
  if (authorization.mode === 'any') return `any of ${abilities}`
  return authorization.mode === 'all' ? `all of ${abilities}` : `${abilities} in a combination no single ability decides`
}
