/**
 * A wildcard bind answers on every interface but is not itself dialable on
 * every platform. Shared with `Application.listen()`'s returned address, which
 * is the same fact rendered twice.
 */
export function isWildcardHost(hostname: string): boolean {
  return hostname === '0.0.0.0' || hostname === '::'
}

/** `host:port`, bracketing an IPv6 literal so the result is dialable. */
export function formatHostPort(hostname: string, port: number): string {
  return `${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`
}
