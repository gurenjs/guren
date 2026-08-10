import type { Context } from 'hono'

export type ResponseHeader = readonly [string, string]

/**
 * Sets each header on the response unless it already carries that header.
 *
 * Use this instead of `ctx.header()` for any header that must reach *every*
 * response. `ctx.header()` writes into Hono's prepared headers, which are only
 * merged when the handler answers through the context (`ctx.text`/`json`/`html`);
 * a handler returning a raw `new Response(...)` replaces `ctx.res` outright and
 * drops them. That is every asset response the framework itself serves, so a
 * header written the other way is simply absent from them.
 *
 * First writer wins, which preserves the precedence the prepared-header form
 * had: anything registered closer to the handler — a route deliberately
 * relaxing `X-Frame-Options` so it can be embedded, or an inner middleware's
 * stronger `Strict-Transport-Security` — overwrote these before and still does.
 */
export function applyResponseHeaders(ctx: Context, headers: readonly ResponseHeader[]): void {
  const response = ctx.res

  try {
    for (const [name, value] of headers) {
      if (!response.headers.has(name)) response.headers.set(name, value)
    }
    return
  } catch (error) {
    // A Response from fetch() or Response.redirect() carries immutable headers
    // on Node and Workers (Bun allows the write). Nothing else is tolerated
    // here — any other failure is a real error and keeps propagating.
    if (!isImmutableHeadersError(error)) throw error
  }

  // Re-wrap rather than re-read: passing `response.body` through hands the same
  // ReadableStream to the replacement, so streamed and file-backed bodies are
  // untouched. Re-checking `has` against the copy is what makes this correct
  // whether or not some writes landed before the throw.
  const merged = new Headers(response.headers)
  for (const [name, value] of headers) {
    if (!merged.has(name)) merged.set(name, value)
  }
  ctx.res = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  })
}

function isImmutableHeadersError(error: unknown): boolean {
  return error instanceof TypeError && /immutable/i.test(error.message)
}
