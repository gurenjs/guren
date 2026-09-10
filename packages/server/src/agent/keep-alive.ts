/**
 * How a best-effort side channel — an audit sink, an approval notification — is
 * invoked so that it can neither fail the call it was only recording nor be
 * lost by the runtime. Three orderings have to hold together, and each is wrong
 * in a way tests off Workers cannot see, so they live here rather than as a
 * comment repeated at every site: a synchronous throw and a rejection both reach
 * `onFailure`; the `.catch` is attached *before* deferring, since `waitUntil` on
 * a rejecting promise raises an unhandled rejection in workerd; and `defer`
 * itself throws there once the response has settled.
 */

/** Passed rather than reached for, since this package is runtime-agnostic. */
export type AgentDeferrer = (work: Promise<unknown>) => void

/** One best-effort side channel, as {@link keepAlive} invokes it. */
export interface BestEffortChannel {
  run: () => void | Promise<void>
  onFailure: (error: unknown) => void
  /** Completes "<label> could not be deferred", so pass a noun phrase. */
  label: string
}

/**
 * Without `defer` the behaviour is the fire-and-forget it has always been; with
 * it, `ExecutionContext.waitUntil` keeps an unfinished channel alive past the
 * response, where an undeferred one is abandoned with the request context.
 */
export function keepAlive(channel: BestEffortChannel, defer: AgentDeferrer | undefined): void {
  let settled: Promise<unknown>
  try {
    settled = Promise.resolve(channel.run()).catch(channel.onFailure)
  } catch (error) {
    channel.onFailure(error)
    return
  }

  if (!defer) return
  try {
    defer(settled)
  } catch (error) {
    console.warn(`[guren] ${channel.label} could not be deferred: ${String(error)}`)
  }
}
