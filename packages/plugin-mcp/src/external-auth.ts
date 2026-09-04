/**
 * The seam an *externally verified* principal reaches the App MCP endpoint
 * through (RFC 0016 §7, `cloudflare:build --mcp-oauth`): the OAuth provider in
 * front of the app validated its own access token and hands the grant's `props`
 * to the protected handler. Not a header — an `X-Guren-*` envelope is one
 * `curl` away from being asserted by a network caller — but a `WeakMap` keyed
 * on **object identity** of the `Request` handed to `app.fetch` (the RFC 0017
 * §2 pattern): nothing on the wire to forge, no `AsyncLocalStorage`, and a
 * `clone()` or `new Request(original)` carries no registration. One module, one
 * map — two copies of this file would be two maps that never hit.
 */
import type { AgentPrincipal } from '@guren/core'

/** An already-verified caller, presented to the endpoint for one request. */
export interface ExternalMcpAuth {
  /** Who the external authority says is calling. */
  principal: AgentPrincipal
  /**
   * In the endpoint's own scope grammar (`tool:<name>`, `tools:read`,
   * `tools:*`, `tools:<prefix>.*`); an entry outside it grants nothing.
   */
  scopes: string[]
}

const presented = new WeakMap<Request, ExternalMcpAuth>()

/**
 * Register `auth` against the identity of `request` and return that same object
 * — the one the caller must dispatch. A copy would key the map on something the
 * endpoint never sees.
 *
 * @example app.fetch(presentExternalMcpAuth(request, auth), env, ctx)
 */
export function presentExternalMcpAuth(request: Request, auth: ExternalMcpAuth): Request {
  presented.set(request, auth)
  return request
}

/**
 * The auth presented for this exact request object, or `undefined`. Not
 * exported from `@guren/plugin-mcp/oauth`: a published reader is a published
 * way to ask "am I trusted?" of something that has no reason to answer.
 */
export function readExternalMcpAuth(request: Request): ExternalMcpAuth | undefined {
  return presented.get(request)
}

/**
 * The `props` shape the scaffolded consent flow stores on an OAuth grant. The
 * screen is session-authenticated, so the only principal a grant can carry is
 * the signed-in user and the only thing it decides beyond identity is which
 * scopes to grant (RFC 0016 Open Question 2). No service principals.
 */
export interface McpOAuthProps {
  userId: string | number
  scopes: string[]
}

/**
 * Map an OAuth grant's `props` onto an {@link ExternalMcpAuth}. They come from
 * the provider's own storage, but are still parsed data that crossed deploys
 * and consent-flow versions, so an unrecognized shape answers `null` rather
 * than a principal guessed out of a partial record. `userId` passes through
 * **unchanged**, string or number: coercing `'12'` to `12` here and nowhere
 * else is how a policy lookup silently misses. An empty `scopes` array is
 * valid — a grant that reaches no tool, which the scope gate denies per call.
 */
export function mcpOAuthPropsToAuth(props: unknown): ExternalMcpAuth | null {
  if (typeof props !== 'object' || props === null) return null

  const { userId, scopes } = props as Record<string, unknown>

  if (typeof userId !== 'string' && typeof userId !== 'number') return null
  // An empty *string* id is not an id. A numeric 0 is, so this is not a
  // truthiness test.
  if (typeof userId === 'string' && userId.length === 0) return null
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) return null

  return {
    principal: { kind: 'user', id: userId, abilities: scopes as string[] },
    scopes: scopes as string[],
  }
}
