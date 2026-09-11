/**
 * How a best-effort side channel (an audit sink, an approval notification, an
 * async log channel) is invoked so that it can neither fail the call it was
 * only recording nor be lost by the runtime. Three orderings have to hold
 * together, and each is wrong in a way tests off Workers cannot see: a
 * synchronous throw and a rejection both reach `onFailure`; the `.catch` is
 * attached *before* deferring, since `waitUntil` on a rejecting promise raises
 * an unhandled rejection in workerd; and `defer` itself throws there once the
 * response has settled.
 */
import { requestDeferrer, type Deferrer } from './request-deferrer'

export type { Deferrer }

/** One best-effort side channel, as {@link keepAlive} invokes it. */
export interface BestEffortChannel {
  run: () => void | PromiseLike<unknown>
  onFailure: (error: unknown) => void
  /** Completes "<label> could not be deferred", so pass a noun phrase. */
  label: string
}

/**
 * `defer` defaults to the deferrer of the Workers request being served, where
 * an undeferred channel is abandoned with the request context; `waitUntil`
 * keeps it alive past the response. Outside a request, and on every other
 * runtime, there is none and the channel is fire-and-forget.
 */
export function keepAlive(channel: BestEffortChannel, defer: Deferrer | undefined = requestDeferrer()): void {
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
