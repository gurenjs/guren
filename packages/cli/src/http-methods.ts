/**
 * The one HTTP-method classification `guren audit` and `guren check`'s
 * agent-route rules share — a second list is how a verb ends up safe in one
 * and unsafe in the other. Orthogonal axes, not a partition: QUERY (RFC 10008)
 * is safe like GET but body-carrying like POST. `SAFE_METHODS` is the RFC 9110
 * §9.2.1 safe set *minus TRACE*, deliberately — do not "fix" it back. Kept in
 * step by convention (no dependency edge) with `DEFAULT_PROTECTED_METHODS` in
 * @guren/server's csrf.ts and `CSRF_SAFE_METHODS` in api-client-types.ts.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'QUERY'])
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'DELETE'])

/**
 * Classifies an HTTP method for the audit phases and the agent-route rules.
 *
 * Fail-closed: a verb neither set recognizes (`router.on('PURGE', ...)`) counts
 * as unsafe AND body-carrying. A false positive is suppressible via
 * config/audit.ts; a silently skipped route cannot be seen at all.
 */
export function describeMethod(method: string): { safe: boolean; bodyCarrying: boolean } {
  const upper = method.toUpperCase()
  return {
    safe: SAFE_METHODS.has(upper),
    bodyCarrying: !BODYLESS_METHODS.has(upper),
  }
}
