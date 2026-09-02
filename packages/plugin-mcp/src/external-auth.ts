/**
 * The seam an *externally verified* principal reaches the App MCP endpoint
 * through (RFC 0016 §7, `cloudflare:build --mcp-oauth`).
 *
 * On Cloudflare Workers behind `@cloudflare/workers-oauth-provider`, the
 * provider has already validated its own access token before the request
 * reaches the app, and hands the grant's `props` to the protected handler as
 * `ctx.props`. The endpoint must therefore be told "this request is already
 * authenticated, as this principal, with these scopes" — and the channel that
 * carries that must not be forgeable.
 *
 * **It is not a header.** Any `X-Guren-*` envelope is one `curl` away from
 * being asserted by a network caller, and the endpoint would have no way to
 * tell the generated worker's claim from an attacker's. The seam is instead a
 * `WeakMap` keyed on **object identity** of the `Request` the generated glue
 * is about to hand to `app.fetch` — the pattern RFC 0017 §2 specifies for its
 * durable principal handoff, for the same reason. A value keyed on object
 * identity has no wire representation to forge, needs no `AsyncLocalStorage`
 * (so it behaves identically on workerd and Bun), and is collected with the
 * request.
 *
 * The identity requirement is load-bearing and easy to lose: `new
 * Request(original)` and `original.clone()` produce *different* objects, and
 * neither carries the registration. That is the security property, not an
 * inconvenience — a copy of a request is exactly what a caller who has the
 * bytes can construct.
 *
 * This module is the leaf both halves import: `plugin.ts` reads the map,
 * `oauth.ts` (the `@guren/plugin-mcp/oauth` subpath, which the generated
 * worker imports) publishes the writer. One module, one map — two copies of
 * this file would be two maps, and the seam would never hit.
 */
import type { AgentPrincipal } from '@guren/core'

/** An already-verified caller, presented to the endpoint for one request. */
export interface ExternalMcpAuth {
  /** Who the external authority says is calling. */
  principal: AgentPrincipal
  /**
   * The scopes that authority granted, in the endpoint's own scope grammar
   * (`tool:<name>`, `tools:read`, `tools:*`, `tools:<prefix>.*` — see
   * `@guren/core`'s `parseToolScope`). Fed to the scope gate exactly where a
   * verified bearer's `abilities` are, so an entry outside the grammar grants
   * nothing rather than everything.
   */
  scopes: string[]
}

const presented = new WeakMap<Request, ExternalMcpAuth>()

/**
 * Register `auth` against the identity of `request`, and return that same
 * object.
 *
 * The return value is the request the caller must dispatch — returning it is
 * what makes the identity requirement hard to get wrong at a call site:
 *
 * ```ts
 * return app.fetch(presentExternalMcpAuth(request, auth), env, ctx)
 * ```
 *
 * It is the *same* object, not a copy: a copy would key the map on something
 * the endpoint never sees.
 */
export function presentExternalMcpAuth(request: Request, auth: ExternalMcpAuth): Request {
  presented.set(request, auth)
  return request
}

/**
 * The auth presented for this exact request object, or `undefined`.
 *
 * Not exported from `@guren/plugin-mcp/oauth`: reading the seam is the
 * endpoint's business, and a published reader is a published way to ask
 * "am I trusted?" of something that has no reason to answer.
 */
export function readExternalMcpAuth(request: Request): ExternalMcpAuth | undefined {
  return presented.get(request)
}

/**
 * The `props` shape the scaffolded consent flow stores on an OAuth grant, and
 * the whole of RFC 0016's Open Question 2 as resolved: the consent screen is
 * **session-authenticated**, so the only principal an OAuth grant can carry is
 * the signed-in user, and the only thing the screen decides beyond identity is
 * which tool scopes to grant.
 *
 * No service principals: nothing in this flow authenticates a machine, and
 * inventing one from a browser consent would be minting an identity the
 * application never asserted.
 */
export interface McpOAuthProps {
  userId: string | number
  scopes: string[]
}

/**
 * Map an OAuth grant's `props` onto an {@link ExternalMcpAuth}.
 *
 * `props` arrive from the provider's own encrypted storage, which means they
 * were written by this application — but they are still *parsed data* that
 * survived a round trip through a store, across deploys, and possibly across
 * versions of the consent flow that wrote them. A shape this cannot recognize
 * answers `null`, and the caller refuses the request; it never guesses a
 * principal out of a partial record.
 *
 * `userId` passes through **unchanged**, string or number.
 * `AgentPrincipal.id` admits both, and the application's own policy lookups
 * are what consume it — coercing `'12'` to `12` here and nowhere else is how
 * a policy lookup silently misses.
 *
 * An empty `scopes` array is a valid answer, not a rejection: it is a grant
 * that reaches no tool, which the scope gate already denies one call at a
 * time. Refusing it here would report "unauthenticated" for a caller who is
 * authenticated and simply granted nothing.
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
