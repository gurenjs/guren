/**
 * Where a best-effort side channel's unfinished promise goes so the runtime
 * keeps it alive past the response: `ExecutionContext.waitUntil` on Workers,
 * where an undeferred promise is abandoned with the request context, silently.
 * One place because `defer` *itself* throws in workerd once the response has
 * settled, and neither the audit trail nor an approval notification may turn
 * that into a failed tool call — a second copy is how one of them comes to.
 */

/** Passed rather than reached for, since this package is runtime-agnostic. */
export type AgentDeferrer = (work: Promise<unknown>) => void

/**
 * `label` completes "<label> could not be deferred", so pass a noun phrase:
 * `agent audit work`, `approval notification for request abc`.
 */
export function createKeepAlive(
  defer: AgentDeferrer | undefined,
  label: string,
): (work: Promise<unknown> | undefined) => void {
  return (work) => {
    if (!work || !defer) return
    try {
      defer(work)
    } catch (error) {
      console.warn(`[guren] ${label} could not be deferred: ${String(error)}`)
    }
  }
}
