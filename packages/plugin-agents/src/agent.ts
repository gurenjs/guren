/**
 * `@guren/plugin-agents/agent` — the workerd-only half.
 *
 * `import { Agent } from 'agents'` eagerly evaluates a graph that statically
 * imports `cloudflare:workers` and `cloudflare:email`, which exist only inside
 * workerd; the SDK offers no lazy path and no alternative export condition.
 *
 * An app imports the package root from `src/app.ts`, which `guren dev` runs on
 * Bun, so the root must never reach this file.
 */
import { Agent, routeAgentRequest } from 'agents'

import type { AgentsRoutingConfig } from './config'
import { resolveAgentRuntime, type AgentRuntime } from './latch'
import {
  firesSooner,
  PendingCallLedger,
  type LedgerSql,
  type PendingToolCall,
} from './ledger'
import {
  createAgentToolClient,
  type AgentToolApprovalSettled,
  type AgentToolCallPending,
  type AgentToolCallResult,
  type AgentToolClient,
} from './tool-client'

/**
 * What an agent's `this.tools` offers: the two calls, and nothing that would
 * have to answer synchronously about a runtime that may not have booted yet.
 *
 * Deliberately not `status`: RFC 0017 §5 promises the *hook*, and an agent that
 * polled the queue by hand would be a second retry rule beside the ledger's.
 */
export type AgentTools = Pick<AgentToolClient, 'call' | 'preflight'>

/** The method the ledger's schedules wake, by the only name the SDK takes. */
const CHECK_CALLBACK = 'checkPendingApprovals'

/** The client and the ledger, both settled against one published runtime. */
interface AgentToolContext {
  client: AgentToolClient
  /** Absent when no encrypter is bound — see {@link AgentRuntime.cipher}. */
  ledger?: PendingCallLedger
}

/**
 * The base class `make:agent` scaffolds.
 *
 * It adds exactly one thing to the SDK's `Agent`: {@link tools}. State, `sql`,
 * schedules, queues, fibers and WebSockets pass through untouched. The package
 * README carries a worked example.
 */
export class GurenAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>,
> extends Agent<Env, State, Props> {
  #context?: Promise<AgentToolContext>
  #tools?: AgentTools
  /** The runtime the cached context was built against, for the staleness check. */
  #builtFor?: AgentRuntime

  /**
   * This agent's tool surface, held for the life of the in-memory instance —
   * which is also the life of its rate budget, so an eviction resets that.
   *
   * A façade whose methods await the runtime, which may not exist yet: Part 2b
   * boots it on whichever arrives first, a request or an alarm.
   */
  get tools(): AgentTools {
    this.#tools ??= {
      call: async (name, args) => this.#call(name, args ?? {}),
      preflight: async (name, args) => (await this.#load()).client.preflight(name, args),
    }
    return this.#tools
  }

  /**
   * What became of a call this agent parked for approval (RFC 0017 §5).
   *
   * Overridable; a no-op by default. A throw is reported and swallowed, because
   * this runs inside a schedule the SDK would otherwise replay.
   */
  onToolApprovalSettled(event: AgentToolApprovalSettled): void | Promise<void> {
    void event
  }

  /**
   * Ask the queue about every parked call and act on the answers. Public
   * because the SDK schedules by method name. Nothing here may throw: a failed
   * delayed callback is retried three times and then dropped, so a throw
   * replays this body against a half-updated ledger and then leaves every
   * surviving row with no wake at all.
   */
  async checkPendingApprovals(): Promise<void> {
    const { client, ledger } = await this.#load()
    if (!ledger) return

    try {
      for (const call of ledger.pruneUnreadable()) await this.#settle(call, 'unreadable')

      for (const call of ledger.pruneExpired(new Date())) await this.#settle(call, 'expired')

      for (const call of ledger.all()) {
        // Per row, so one unanswerable request cannot strand the others: a tool
        // a deploy removed throws out of `client.call`, and without this the
        // whole sweep would die on it, every wake, until the rows expired.
        try {
          await this.#settleOne(client, ledger, call)
        } catch (error) {
          console.warn(
            `[@guren/plugin-agents] Could not settle the approval for "${call.tool}" `
            + `(request ${call.requestId}): ${describe(error)}. The row is kept and will be `
            + 'checked again until it expires.',
          )
          ledger.bumpChecks(call.requestId)
        }
      }
    } finally {
      // In `finally` for the same reason the loop catches: whatever happened
      // above, the rows still waiting need a next wake.
      await this.#scheduleCheck(ledger, true)
    }
  }

  /** One row's verdict. Every ledger write lands before the hook is called. */
  async #settleOne(
    client: AgentToolClient,
    ledger: PendingCallLedger,
    call: PendingToolCall,
  ): Promise<void> {
    const answer = await client.status(call.requestId)

    // Unanswerable, not answered: keeping the row is the whole reason that
    // variant exists. Purging here would drop the arguments an approval granted
    // an hour later needs, and nothing would report it. Still counted —
    // `checks` is the backoff's clock, so a spent budget has to back off rather
    // than re-ask at the same cadence until the request expires.
    if (answer.unavailable) {
      ledger.bumpChecks(call.requestId)
      return
    }

    if (!answer.found) {
      ledger.remove(call.requestId)
      await this.#settle(call, 'unknown')
      return
    }

    const { status, consumedAt } = answer.report
    if (status === 'pending') {
      ledger.bumpChecks(call.requestId)
      return
    }

    if (status === 'approved') {
      await this.#settleApproved(client, ledger, call, consumedAt !== undefined)
      return
    }

    ledger.remove(call.requestId)
    await this.#settle(call, status === 'rejected' ? 'rejected' : 'expired')
  }

  /**
   * An approved row: repeat the call unless the approval is already spent.
   * Every ledger write lands before the hook is called.
   */
  async #settleApproved(
    client: AgentToolClient,
    ledger: PendingCallLedger,
    call: PendingToolCall,
    spent: boolean,
  ): Promise<void> {
    if (spent) {
      // Approvals bind to this principal and this exact fingerprint, so nobody
      // else could have spent it: a previous sweep ran the call and was
      // interrupted before clearing the row. Re-calling would find no
      // unconsumed match, file a *new* request, page a human, and run the side
      // effect a second time on approval.
      ledger.remove(call.requestId)
      await this.#settle(call, 'approved')
      return
    }

    // The original call, with the stored arguments: the queue's consume-on-use
    // and fingerprint match make this spend exactly the approval that was
    // granted, and nothing else.
    const result = await client.call(call.tool, call.args)

    if (result.pending) {
      // Spent between the status read and the retry, so the gate filed a fresh
      // request. Follow the id it reports rather than dropping the arguments
      // the new request will need.
      if (result.requestId === call.requestId) {
        ledger.bumpChecks(call.requestId)
        return
      }
      ledger.remove(call.requestId)
      this.#park(ledger, result, call.args)
      return
    }

    if (result.denied && result.reason === 'rate-limit') {
      // The budget the status check just spent. Reporting this as the
      // approval's outcome would drop the row, and a human's approval would be
      // spent by nobody and never retried.
      ledger.bumpChecks(call.requestId)
      return
    }

    ledger.remove(call.requestId)
    await this.#settle(call, 'approved', result)
  }

  /**
   * Call the hook, which is application code and may throw.
   *
   * A throw here would replay the sweep, so it is reported and swallowed: the
   * ledger write it follows has already happened, and the alternative is
   * re-running calls that were settled correctly.
   */
  async #settle(
    call: { requestId: string; tool: string },
    status: AgentToolApprovalSettled['status'],
    result?: AgentToolCallResult,
  ): Promise<void> {
    try {
      await this.onToolApprovalSettled({
        requestId: call.requestId,
        tool: call.tool,
        status,
        ...(result ? { result } : {}),
      })
    } catch (error) {
      console.warn(
        `[@guren/plugin-agents] onToolApprovalSettled threw for request ${call.requestId} `
        + `(${call.tool}, ${status}): ${describe(error)}`,
      )
    }
  }

  async #call(name: string, args: Record<string, unknown>): Promise<AgentToolCallResult> {
    const { client, ledger } = await this.#load()
    const result = await client.call(name, args)
    // Checkpointed before the result is returned: an agent that parked a call
    // and was evicted on the next line must still be able to retry it.
    if (result.pending && ledger && this.#park(ledger, result, args)) {
      await this.#scheduleCheck(ledger, false)
    }
    return result
  }

  /**
   * Checkpoint the arguments the queue cannot keep.
   * @returns whether the call was checkpointed.
   */
  #park(
    ledger: PendingCallLedger,
    result: AgentToolCallPending,
    args: Record<string, unknown>,
  ): boolean {
    // Both instants come from the queue's own record. Without an expiry the row
    // could never be pruned, and extending the TTL is not the agent's to do.
    if (!result.expiresAt) return false
    ledger.record({
      requestId: result.requestId,
      tool: result.tool,
      args,
      requestedAt: result.requestedAt ?? new Date().toISOString(),
      expiresAt: result.expiresAt,
    })
    return true
  }

  /**
   * Hold the ledger to exactly one pending check.
   * @param replace Always true after a sweep, so a lengthening backoff takes
   *   effect. False on the record path, where an existing check is kept only if
   *   it fires before the one this row needs.
   */
  async #scheduleCheck(ledger: PendingCallLedger, replace: boolean): Promise<void> {
    const now = new Date()
    const delay = ledger.nextDelaySeconds(now)
    if (delay === undefined) return

    // `ScheduleCriteria` filters on id, type and time only, so the callback is
    // matched here rather than by the query.
    const existing = (await this.listSchedules({ type: 'delayed' })).filter(
      (schedule) => schedule.callback === CHECK_CALLBACK,
    )
    if (!replace && !firesSooner(delay, now, existing.map((schedule) => schedule.time))) return

    for (const schedule of existing) await this.cancelSchedule(schedule.id)

    await this.schedule(delay, CHECK_CALLBACK as keyof this)
  }

  async #load(): Promise<AgentToolContext> {
    // The runtime slot is last-publish-wins, so a context held across a later
    // publish would keep dispatching into the application that was replaced.
    // Once the latch is settled this is a slot read: a promise, not a boot.
    const runtime = await resolveAgentRuntime(this.env)
    if (this.#context && this.#builtFor === runtime) return this.#context

    this.#builtFor = runtime
    this.#context = this.#build(runtime)
    return this.#context
  }

  async #build(runtime: AgentRuntime): Promise<AgentToolContext> {
    // Facets reuse `this.name` under a different parent, so a facet and a root
    // agent can carry the same principal id — and approvals are isolated by
    // that id. `selfPath` would disambiguate them but is `@experimental`, and a
    // facet's scopes are undesigned, so this refuses rather than guessing.
    if (isFacet(this)) {
      throw new Error(
        `The agent class "${this.constructor.name}" is running as a facet (a sub-agent). `
        + '@guren/plugin-agents does not support facets in this part: a facet reuses its parent\'s '
        + 'instance name, so its principal id would not be unique, and approvals are isolated by '
        + 'that id. Call tools from a root agent instead.',
      )
    }

    // The only identity a Durable Object class carries at runtime — there is no
    // source path to recover from a constructor. Stable in a deploy bundle by
    // repo policy: Guren keys durable records on class names, so no deploy
    // plugin may bundle app code with identifier mangling, and none does.
    const exportName = this.constructor.name
    const registration = runtime.registrations.get(exportName)
    if (!registration) {
      throw new Error(
        `The agent class "${exportName}" is not registered. Add it to config/agents.ts:\n`
        + `  ${lowerFirst(exportName)}: { module: 'app/Agents/${exportName}.ts', export: '${exportName}', scopes: ['tools:read'] }\n`
        + describeRegistered(runtime),
      )
    }

    const client = createAgentToolClient({
      runtime,
      agentName: registration.name,
      // The SDK's own instance name (`Agent.name`), which is the `:instance`
      // half of `agent:<name>:<instance>` — the per-instance principal that
      // keeps one instance from spending another's approval.
      instanceId: this.name,
    })

    // Bound rather than passed: `this.sql` is a method, and handing the
    // reference over would call it with the ledger as its receiver.
    const sql: LedgerSql = (strings, ...values) => this.sql(strings, ...values)
    return {
      client,
      ...(runtime.cipher ? { ledger: new PendingCallLedger(sql, runtime.cipher) } : {}),
    }
  }
}

const UNCONFIGURED_ROUTING =
  'This application hosts durable agents, but nothing says who may address one, so /agents/* is '
  + 'refused. Declare an authorizer in config/agents.ts:\n'
  + '  export default defineAgentsConfig({\n'
  + '    agents: { … },\n'
  + '    routing: { authorize: (request, target) => /* your check */ false },\n'
  + '  })'

const REFUSED_ROUTING = 'You may not address this agent instance.'

/** `routeAgentRequest`'s default prefix, as a path — the SDK owns everything beneath it. */
const AGENTS_PREFIX = '/agents/'

/**
 * Route `/agents/<binding>/<instance>` to its Durable Object behind the app's
 * authorizer — RFC 0017 §6's default-deny mount. The authorizer sits in both
 * pre-dispatch hooks (`onBeforeRequest`; `onBeforeConnect` for WebSocket
 * upgrades), where a `Response` short-circuits before the Durable Object exists.
 * @param bindings The bindings hosting *registered* agents; the SDK would route to every one in `env`.
 */
export async function routeGuardedAgentRequest(
  request: Request,
  env: unknown,
  routing: AgentsRoutingConfig | undefined,
  bindings: readonly string[],
): Promise<Response | undefined> {
  // A `typeof` test, not a truthiness one: the config is app-authored
  // JavaScript, and `authorize: true` must refuse rather than throw.
  const authorize = routing?.authorize
  if (typeof authorize !== 'function') {
    // Refused before the SDK sees it: the router answers 400 for an unknown
    // binding *ahead of* either hook, which would let an anonymous caller tell
    // bound names from unbound ones. Unconfigured, the whole prefix is one 403.
    return new URL(request.url).pathname.startsWith(AGENTS_PREFIX)
      ? refuse(UNCONFIGURED_ROUTING)
      : undefined
  }

  const guard = async (incoming: Request, route: { className: string; name: string }) => {
    // `className` is the SDK's name for the *binding* it resolved the URL segment
    // to (`Extract<keyof Env, string>`), not the class and not the config key.
    // Same 403 as a refusal, so the list cannot be probed.
    if (!bindings.includes(route.className)) return refuse(REFUSED_ROUTING)
    const verdict = await authorize(incoming, { agent: route.className, instance: route.name })
    if (verdict instanceof Response) return verdict
    return verdict === true ? undefined : refuse(REFUSED_ROUTING)
  }

  const routed = await routeAgentRequest(request, env, {
    onBeforeRequest: guard,
    onBeforeConnect: guard,
  })
  // The SDK answers `null` for a path it does not own; this surface answers
  // `undefined`, so a caller writes `if (routed) return routed`.
  return routed ?? undefined
}

function refuse(message: string): Response {
  return new Response(JSON.stringify({ error: 'forbidden', message }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  })
}

function describeRegistered(runtime: AgentRuntime): string {
  const names = [...runtime.registrations.keys()]
  return names.length > 0
    ? `Currently registered classes: ${names.join(', ')}.`
    : 'config/agents.ts registers no agents at all.'
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1)
}

/**
 * Whether this agent is running as a facet (the SDK's sub-agent form).
 *
 * `parentPath` is empty for a root and holds the ancestor chain for a facet.
 * It is `@experimental`, so a shape this cannot read is treated as "root":
 * otherwise every agent breaks the day the getter is renamed.
 */
function isFacet(agent: { parentPath?: unknown }): boolean {
  const path = agent.parentPath
  return Array.isArray(path) && path.length > 0
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
