/**
 * The principal handoff seam (RFC 0017 §2) and the scope-gated dispatch mark,
 * a leaf module the pipeline writes and the auth context reads — in either of
 * them, one would import the other's whole layer. Keyed on the **object identity** of the `Request` handed to
 * `app.fetch`, so it has no wire representation to forge, needs no
 * `AsyncLocalStorage` (identical on workerd and Bun), and is collected with the
 * request. `new Request(original)` and `clone()` carry nothing: that is the
 * security property. Not exported from the package index — see the writer.
 */
import type { AgentPrincipal } from '../agent/events'

/** What an installed principal answers for, for the life of one request. */
export interface InstalledAgentPrincipal {
  /** Who the pipeline resolved before it built the request. */
  principal: AgentPrincipal
  /**
   * The scopes the pipeline gated the call with, carried for completeness.
   * Nothing in the auth context consults them: scopes are the *pipeline's*
   * verdict, taken before dispatch, and re-judging them inside the request
   * would be a second, quieter scope rule beside the real one.
   */
  abilities: readonly string[]
}

const installed = new WeakMap<Request, InstalledAgentPrincipal>()

/**
 * Mark `request` as carrying `principal`, returning that same object — a copy
 * would key the map on something the auth context never sees. Returning it is
 * what makes the identity requirement hard to get wrong at a call site:
 * `app.fetch(installAgentPrincipal(request, installed), env, ctx)`. Callers
 * reach this through the pipeline's `handoff: 'seam'`, and the reader not at all.
 */
export function installAgentPrincipal(
  request: Request,
  value: InstalledAgentPrincipal,
): Request {
  installed.set(request, value)
  return request
}

/** The principal installed on this exact request object, or `undefined`. */
export function readAgentPrincipal(request: Request): InstalledAgentPrincipal | undefined {
  return installed.get(request)
}

const dispatched = new WeakSet<Request>()

/**
 * Mark `request` as a tool call the pipeline scope-gated, returning that same
 * object: a token granting only agent tools authenticates such a request and no
 * other. Not `markDispatchedToolRequest()`, which `buildToolRequest` sets for
 * un-gated callers too (`guren tool:call`, `TestApp.agent()`, plugin-webmcp).
 */
export function markAgentDispatch(request: Request): Request {
  dispatched.add(request)
  return request
}

/** Whether the pipeline dispatched this exact request object. */
export function isAgentDispatch(request: Request): boolean {
  return dispatched.has(request)
}

const sharedProps = new WeakMap<Request, ReadonlySet<string>>()

/**
 * Mark `request` as allowed only the named shared Inertia props (RFC 0038 §6),
 * returning that same object. A surface opts in through the pipeline's
 * `sharedProps`; nothing on the wire can ask for it, and nothing can widen it.
 */
export function installAgentSharedProps(request: Request, keys: readonly string[]): Request {
  sharedProps.set(request, new Set(keys))
  return request
}

/** The shared props this exact request may carry, or `undefined` for all of them. */
export function readAgentSharedProps(request: Request): ReadonlySet<string> | undefined {
  return sharedProps.get(request)
}
