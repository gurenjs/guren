/**
 * The one place an agent audit event is announced: to the configured sink, and
 * to the application's event listeners.
 *
 * Here rather than in a protocol adapter because it has two readers —
 * `@guren/plugin-mcp` binds one into the container at boot, `guren tool:call`
 * resolves that binding for the `'cli'` surface. A second copy is how one
 * surface comes to swallow a sink failure the other warns about. Its own module
 * so it can be exercised without standing up an endpoint.
 */
import type { AgentToolDenied, AgentToolInvoked } from './events'
import type { EventManager } from '../events'
import { toAuditRecord, type AgentAuditRecord } from './audit'

/**
 * The container service an application's audit emitter is published under
 * (`ServiceBindings['agent.audit']`). A constant because `@guren/plugin-mcp`
 * binds it and `@guren/cli` resolves it, and neither depends on the other; two
 * drifted literals would break the wiring *silently* — the CLI recording
 * nothing reads exactly like an application that configured no trail.
 */
export const AGENT_AUDIT_BINDING = 'agent.audit'

/** What an application hands each audit event to. */
export type AgentAuditSink = (record: AgentAuditRecord) => void | Promise<void>

/**
 * What every agent surface calls to record one invocation or one denial. Named
 * because it is a container binding (`'agent.audit'`) as well as a return value.
 */
export type AgentAuditEmitter = (event: AgentToolInvoked | AgentToolDenied) => void

/** Options an emitter is built with, beyond its sink and its events. */
export interface AuditEmitterOptions {
  /**
   * Where an unfinished write goes so the runtime keeps it alive past the
   * response: `ExecutionContext.waitUntil` on Workers, where an undeferred one
   * is abandoned with the request context, silently. Passed rather than reached
   * for, since this package is runtime-agnostic.
   */
  defer?: (work: Promise<unknown>) => void
}

/**
 * **The sink is called directly, not subscribed as a listener**:
 * `EventManager.emit` awaits listeners in a bare `for` loop, so one unrelated
 * application listener throwing would silence the trail. The events are still
 * emitted for genuine listeners (RFC 0016 §5.2). Neither half may fail the call
 * it records: both are caught, the sink's failure warned rather than swallowed.
 */
export function createAuditEmitter(
  sink: AgentAuditSink | undefined,
  events: EventManager | undefined,
  now: () => Date = () => new Date(),
  options: AuditEmitterOptions = {},
): AgentAuditEmitter {
  // `defer` itself throws in workerd when called after the response settled,
  // and a best-effort trail may not turn that into a failed tool call.
  const keepAlive = (work: Promise<unknown>): void => {
    if (!options.defer) return
    try {
      options.defer(work)
    } catch (error) {
      console.warn(`[guren] agent audit work could not be deferred: ${String(error)}`)
    }
  }

  return (event) => {
    if (sink) {
      // The clock is read once, here, and the record carries the instant it
      // produced — see `toAuditRecord`.
      try {
        // Deferred *after* the catch is attached: `waitUntil` on a rejecting
        // promise raises an unhandled rejection in workerd.
        keepAlive(Promise.resolve(sink(toAuditRecord(event, now()))).catch(warnSinkFailure))
      } catch (error) {
        warnSinkFailure(error)
      }
    }

    const emitted = events?.emit(event).catch((error) => {
      console.warn(`[guren] audit event listener failed: ${String(error)}`)
    })
    if (emitted) {
      keepAlive(emitted)
    }
  }
}

function warnSinkFailure(error: unknown): void {
  console.warn(`[guren] agent audit sink failed, record dropped: ${String(error)}`)
}
