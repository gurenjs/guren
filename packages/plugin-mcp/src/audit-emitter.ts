/**
 * The one place an agent audit event is announced: to the configured sink, and
 * to the application's event listeners.
 *
 * Its own module so it can be exercised without an endpoint. The alternative
 * is a closure inside the plugin's `boot`, reachable only by standing up a
 * server and making a real tool call — which is worth doing once, and is the
 * wrong price for the several cases that matter here (a sink that throws, a
 * sink beside a listener that throws, a sink with no event manager at all).
 */
import { AgentToolDenied, AgentToolInvoked, toAuditRecord, type AgentAuditRecord, type EventManager } from '@guren/core'

/** What the plugin hands each audit event to. */
export type AgentAuditSink = (record: AgentAuditRecord) => void | Promise<void>

/**
 * Build the function the endpoint calls for every invocation and denial.
 *
 * **The sink is called directly, not subscribed as a listener**, and that is
 * the whole reason this function exists rather than an `events.on(...)` pair.
 * `EventManager.emit` awaits its listeners in priority order inside a bare
 * `for` loop, so the first one to throw ends the loop and every listener after
 * it never runs. An unrelated application listener registered at a higher
 * priority would then silence the audit trail, and the only evidence an
 * operator would have of that is an empty file. A record of what agents did
 * cannot be contingent on what else the application happens to listen for.
 *
 * The events are still emitted, unchanged, for every consumer that
 * legitimately is a listener — RFC 0016 §5.2's "forward them wherever you
 * already forward events" is untouched.
 *
 * Neither half may fail the tool call it is recording, so both are caught. The
 * sink's failure is *warned* rather than swallowed: an audit sink dropping
 * records in silence is precisely the failure this feature exists to prevent.
 */
export function createAuditEmitter(
  sink: AgentAuditSink | undefined,
  events: EventManager | undefined,
  now: () => Date = () => new Date(),
): (event: AgentToolInvoked | AgentToolDenied) => void {
  return (event) => {
    if (sink) {
      // The clock is read once, here, and the record carries the instant it
      // produced — see `toAuditRecord`.
      try {
        void Promise.resolve(sink(toAuditRecord(event, now()))).catch(warnSinkFailure)
      } catch (error) {
        warnSinkFailure(error)
      }
    }

    void events?.emit(event).catch((error) => {
      console.warn(`[@guren/plugin-mcp] audit event listener failed: ${String(error)}`)
    })
  }
}

function warnSinkFailure(error: unknown): void {
  console.warn(`[@guren/plugin-mcp] agent audit sink failed, record dropped: ${String(error)}`)
}
