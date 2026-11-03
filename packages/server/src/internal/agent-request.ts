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
