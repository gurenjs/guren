/**
 * The one HTTP-method classification the static analyses share.
 *
 * `guren audit` gates its two per-route phases on it, and `guren check`'s
 * agent-route rules gate their input-schema rule on the same answer. A second
 * hand-written list of "the body-carrying verbs" beside this one is how a
 * verb ends up safe in one command and unsafe in the other.
 *
 * The two sets are orthogonal axes rather than a partition: unsafe methods
 * get the auth check, body-carrying methods get the validation check, and
 * QUERY (RFC 10008) is both — safe like GET, but body-carrying like POST.
 *
 * `SAFE_METHODS` holds the verbs the authentication phase trusts not to
 * change state. It is the RFC 9110 §9.2.1 safe set *minus TRACE*, on
 * purpose: an app registering a TRACE route is unusual enough that the
 * fail-closed default below is the better answer — do not "fix" the list
 * back to the RFC. It is the same axis as `DEFAULT_PROTECTED_METHODS` in
 * `@guren/server` (src/http/middleware/csrf.ts, expressed as its
 * complement) and the emitted `CSRF_SAFE_METHODS` in api-client-types.ts;
 * the packages share no dependency edge, so the list is duplicated by
 * convention (see trimSlashes in utils.ts for the precedent).
 *
 * `BODYLESS_METHODS` are the verbs whose requests conventionally carry no
 * body, so the validation phase demands no validateBody() for them.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'QUERY'])
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'DELETE'])

/**
 * Classifies an HTTP method for the audit phases and the agent-route rules.
 *
 * Deliberately fail-closed: a verb neither set recognizes — anything an app
 * registers via `router.on('PURGE', ...)` — is treated as unsafe AND
 * body-carrying. The alternative (skipping it, as the pre-classification
 * enumerations did) made a custom-verb route with an unvalidated body and no
 * auth middleware produce zero findings, i.e. the routes the audit
 * understands least reported the cleanest pass. A false-positive finding on
 * a genuinely body-less custom verb can be suppressed via config/audit.ts;
 * a silently skipped route cannot be seen at all.
 */
export function describeMethod(method: string): { safe: boolean; bodyCarrying: boolean } {
  const upper = method.toUpperCase()
  return {
    safe: SAFE_METHODS.has(upper),
    bodyCarrying: !BODYLESS_METHODS.has(upper),
  }
}
