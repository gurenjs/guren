/**
 * The one place an agent audit event is announced: to the configured sink, and
 * to the application's event listeners.
 *
 * Here rather than in a protocol adapter because it has two readers and will
 * grow more. `@guren/plugin-mcp` builds one at boot and binds it into the
 * container; `guren tool:call` resolves that binding and records the `'cli'`
 * surface through the very same function. A second copy is how one surface
 * comes to swallow a sink failure the other warns about, or to keep calling a
 * sink as an event listener after the other stopped — and the evidence of
 * either would be a trail that is quietly missing a surface.
 *
 * Its own module so it can be exercised without an endpoint. The alternative
 * is a closure inside the plugin's `boot`, reachable only by standing up a
 * server and making a real tool call — which is worth doing once, and is the
 * wrong price for the several cases that matter here (a sink that throws, a
 * sink beside a listener that throws, a sink with no event manager at all).
 */
import type { AgentToolDenied, AgentToolInvoked } from './events'
import type { EventManager } from '../events'
import { toAuditRecord, type AgentAuditRecord } from './audit'

/**
 * The container service an application's audit emitter is published under
 * (`ServiceBindings['agent.audit']`).
 *
 * A constant rather than a literal at each site, because this is the first
 * binding written by one package and read by another that cannot import it:
 * `@guren/plugin-mcp` binds it, `@guren/cli` resolves it, and neither depends
 * on the other. Two literals that drifted would break the wiring *silently* —
 * the CLI would resolve nothing and record nothing, which reads exactly like
 * an application that configured no trail. That is the one failure this
 * feature exists to prevent, so it may not be spelled twice.
 */
export const AGENT_AUDIT_BINDING = 'agent.audit'

/** What an application hands each audit event to. */
export type AgentAuditSink = (record: AgentAuditRecord) => void | Promise<void>

/**
 * What every agent surface calls to record one invocation or one denial.
 *
 * Named because it is a container binding (`'agent.audit'`) as well as a return
 * value: a caller resolving it has to be able to say what it expects to find.
 */
export type AgentAuditEmitter = (event: AgentToolInvoked | AgentToolDenied) => void

/**
 * Build the function a surface calls for every invocation and denial.
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
): AgentAuditEmitter {
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
      console.warn(`[guren] audit event listener failed: ${String(error)}`)
    })
  }
}

function warnSinkFailure(error: unknown): void {
  console.warn(`[guren] agent audit sink failed, record dropped: ${String(error)}`)
}
