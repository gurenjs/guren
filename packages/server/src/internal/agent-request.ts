/**
 * How a request says it is an agent tool call (RFC 0016 §3), in a leaf module
 * so the dispatcher that writes the header and the auth middlewares that read
 * it share one spelling. Not exported from the package index.
 *
 * Read only to choose the *shape* of a refusal: a tool caller cannot follow a
 * redirect, so a guard answers it with JSON instead. Nothing may authorize on
 * it, since any client can send it and gets no more than a JSON refusal.
 */

/** Request header naming the protocol surface a tool call arrived on. */
export const AGENT_SURFACE_HEADER = 'X-Guren-Agent-Surface'

export interface HeaderReader {
  req?: { header(name: string): string | undefined }
}

/** Whether the request was built by the agent dispatcher (`buildToolRequest`). */
export function isAgentToolRequest(ctx: HeaderReader): boolean {
  return ctx.req?.header(AGENT_SURFACE_HEADER) !== undefined
}

/**
 * Container key for the shared Inertia props an App MCP tool call may carry
 * (RFC 0038 §6), bound by `@guren/plugin-mcp`. Unbound, shared props are not
 * projected. Reading the header here is safe in this direction only: a forged
 * header withholds props, it never adds any.
 */
export const AGENT_SHARED_PROPS_BINDING = 'agent.sharedProps'

/** The allowlist to project shared props through, or undefined to send them all. */
export function agentSharedPropsAllowlist(
  ctx: HeaderReader,
  container: { make(key: string): unknown; has?(key: string): boolean } | undefined,
): ReadonlySet<string> | undefined {
  if (ctx.req?.header(AGENT_SURFACE_HEADER) !== 'mcp') return undefined
  if (!container?.has?.(AGENT_SHARED_PROPS_BINDING)) return undefined
  const allowed = container.make(AGENT_SHARED_PROPS_BINDING)
  return Array.isArray(allowed) ? new Set(allowed.map(String)) : new Set()
}
