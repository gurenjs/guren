/**
 * A wildcard bind answers on every interface but is not itself dialable on
 * every platform. The dev banner and `Application.listen()`'s returned address
 * both render this fact.
 */
export function isWildcardHost(hostname: string): boolean {
  return hostname === '0.0.0.0' || hostname === '::'
}

/** `host:port`, bracketing an IPv6 literal so the result is dialable. */
export function formatHostPort(hostname: string, port: number): string {
  return `${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`
}
