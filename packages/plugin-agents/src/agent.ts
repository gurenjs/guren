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
import { createAgentToolClient, type AgentToolClient } from './tool-client'

/**
 * What an agent's `this.tools` offers: the two calls, and nothing that would
 * have to answer synchronously about a runtime that may not have booted yet.
 */
export type AgentTools = Pick<AgentToolClient, 'call' | 'preflight'>

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
  #client?: Promise<AgentToolClient>
  #tools?: AgentTools
  /** The runtime the cached client was built against, for the staleness check. */
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
      call: async (name, args) => (await this.#load()).call(name, args),
      preflight: async (name, args) => (await this.#load()).preflight(name, args),
    }
    return this.#tools
  }

  async #load(): Promise<AgentToolClient> {
    // The runtime slot is last-publish-wins, so a client held across a later
    // publish would keep dispatching into the application that was replaced.
    // Once the latch is settled this is a slot read: a promise, not a boot.
    const runtime = await resolveAgentRuntime(this.env)
    if (this.#client && this.#builtFor === runtime) return this.#client

    this.#builtFor = runtime
    this.#client = this.#buildClient(runtime)
    return this.#client
  }

  async #buildClient(runtime: AgentRuntime): Promise<AgentToolClient> {
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

    return createAgentToolClient({
      runtime,
      agentName: registration.name,
      // The SDK's own instance name (`Agent.name`), which is the `:instance`
      // half of `agent:<name>:<instance>` — the per-instance principal that
      // keeps one instance from spending another's approval.
      instanceId: this.name,
    })
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
