import type { Context } from 'hono'

export type ResponseHeader = readonly [string, string]

/**
 * Sets each header unless the response already carries it. Use this rather than
 * `ctx.header()` for headers that must reach *every* response: prepared headers
 * are dropped by a handler returning a raw `new Response(...)`, which is every
 * asset response the framework serves. First writer wins, so anything registered
 * closer to the handler still overrides these.
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
    // on Node and Workers (Bun allows the write).
    if (!isImmutableHeadersError(error)) throw error
  }

  // Passing `response.body` through hands the same ReadableStream to the
  // replacement, leaving streamed and file-backed bodies untouched. Re-checking
  // `has` keeps this correct whether or not writes landed before the throw.
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
