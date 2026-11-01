/**
 * The caller's headers with each default set only where the caller named none. Header
 * names are case-insensitive, so a caller's `content-type` replaces `Content-Type`
 * rather than joining it; spreading a `Headers` or a pair list would drop it.
 */
export function withDefaultHeaders(init: HeadersInit | undefined, defaults: Record<string, string>): Headers {
  const headers = new Headers(init)
  for (const [name, value] of Object.entries(defaults)) {
    if (!headers.has(name)) {
      headers.set(name, value)
    }
  }
  return headers
}
