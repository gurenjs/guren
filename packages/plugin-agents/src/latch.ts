/**
 * The seam between the booted application and the Durable Objects that call its
 * tools (RFC 0017 §6).
 *
 * An agent is woken by an alarm or by the SDK's router, and its constructor
 * receives the Worker's `env` — not an `Application`. So it has to *find* the
 * app booted in its isolate, and this is where it looks.
 *
 * A leaf module: nothing here imports the plugin, the client, or `agents`.
 */
import type {
  AgentAuditEmitter,
  AgentDispatchTarget,
  DerivedAgentTool,
} from '@guren/core'

import type { AgentBudgetConfig, AgentsApprovalsConfig } from './config'

/** What the plugin resolved for one registered agent at boot. */
export interface AgentRegistration {
  /** The `config/agents.ts` key — half the principal id (`agent:<name>:<instance>`). */
  readonly name: string
  /**
   * The tools this registration's scopes expanded to at boot, as `tool:<name>`.
   *
   * Expanded once, against a route graph a human could read, rather than per
   * call. Frozen, and the scope gate and the audit principal share this one
   * array — see {@link freezeAgentRegistrations}.
   */
  readonly abilities: readonly string[]
  readonly budget?: AgentBudgetConfig
}

/** Everything an agent instance needs to call its application's tools. */
export interface AgentRuntime {
  /** The booted application the dispatched request re-enters. */
  app: AgentDispatchTarget
  /** Every tool derived from the route graph — not only the ones any agent may call. */
  tools: DerivedAgentTool[]
  /**
   * Keyed by **export name**, which is the only identity a Durable Object class
   * carries at runtime (`this.constructor.name`). See `GurenAgent` for why that
   * name is stable in a deploy bundle.
   */
  registrations: ReadonlyMap<string, AgentRegistration>
  /**
   * Where invocations and denials are recorded — a resolver, not an emitter.
   *
   * `AGENT_AUDIT_BINDING` is published by another plugin's `boot`, so which
   * plugin sees it depends on `providers` order. Resolving at first use is the
   * first moment the answer is stable; `agentsPlugin` builds the resolver.
   */
  audit?: () => AgentAuditEmitter
  approvals?: AgentsApprovalsConfig
}

/**
 * How a runtime that does not exist yet comes to exist: "boot it now, on this
 * `env`". An agent can be woken by an alarm before any request has booted.
 *
 * It may return nothing — a resolver that boots an app has already published
 * through {@link configureAgentRuntime}.
 */
export type AgentRuntimeResolver = (
  env: unknown,
) => AgentRuntime | void | Promise<AgentRuntime | void>

/**
 * Two slots, because the two callers arrive at different times: the resolver is
 * the build's wiring, registered at module scope; the runtime is the plugin's
 * answer, published from `boot`. One slot would make the plugin's publish read
 * as a replacement of the resolver that caused it.
 */
let runtimeSlot: AgentRuntime | undefined
/** Refuses a replacement: generated code registers exactly one, at module scope. */
let resolverSlot: AgentRuntimeResolver | undefined

/**
 * The resolution in flight, shared by every caller that arrives during it.
 *
 * Without it an alarm and a request arriving together each boot the app, and
 * whichever finished last owns the slot. RFC 0017 §6's promise-latched boot.
 */
let inFlight: Promise<AgentRuntime> | undefined

/**
 * The `env` the resolution was started for — RFC 0017 §6's hard error.
 *
 * A second caller with a different `env` would otherwise join the first
 * resolution and run against bindings that are not its own, which nothing
 * downstream can detect.
 */
let resolvedEnv: unknown
/** Compared by identity: two structurally similar envs are still two environments. */
let resolvedEnvSeen = false

const UNCONFIGURED =
  'No agent runtime is configured, so this agent cannot reach its application. '
  + 'On Cloudflare this is wired by `guren cloudflare:build`, which generates the worker entry '
  + 'that boots the app and calls configureAgentRuntime(). In a test, call '
  + 'configureAgentRuntime({ app, tools, registrations }) before driving the agent.'

const RESOLVER_REPLACED =
  'configureAgentRuntime() was called a second time with a different resolver. The resolver is '
  + 'the generated worker\'s boot wiring, and there is one of those per isolate.'

const RESOLVER_PUBLISHED_NOTHING =
  'The agent runtime resolver ran but published no runtime. A resolver that boots the application '
  + 'must have agentsPlugin() among its providers — that plugin is what calls '
  + 'configureAgentRuntime() with the booted runtime.'

const ENV_REPLACED =
  'The agent runtime was resolved for a different `env` object. One isolate serves one '
  + 'environment: a second env means two deployments are sharing this module graph, and a tool '
  + 'call would run against bindings that are not its own (RFC 0017 §6).'

/**
 * Publish the runtime this isolate's agents call through, or the wiring for it.
 *
 * Publishing never throws: the latest wins, because `agentsPlugin` mints a
 * fresh runtime per boot and a process may boot several applications.
 * @throws When a *different* resolver is already registered.
 */
export function configureAgentRuntime(runtime: AgentRuntime | AgentRuntimeResolver): void {
  if (typeof runtime === 'function') {
    if (resolverSlot !== undefined && resolverSlot !== runtime) {
      throw new Error(RESOLVER_REPLACED)
    }
    resolverSlot = runtime
    return
  }

  runtimeSlot = runtime
}

/**
 * The runtime this isolate's agents call through.
 * @param env Forwarded to a resolver and pinned to the isolate — a second,
 *   different one is a hard error.
 * @throws When nothing has been configured; the message names both fixes.
 */
export async function resolveAgentRuntime(env?: unknown): Promise<AgentRuntime> {
  // Checked before the slot, not after. A resolver that is *still running* has
  // not finished booting the application, and `agentsPlugin` publishes from
  // inside `boot` — so returning the slot the moment it appears hands out an
  // application whose later providers have not booted. Joining the in-flight
  // resolution is what makes "published" mean "usable".
  if (inFlight !== undefined) {
    assertSameEnv(env)
    return inFlight
  }

  if (runtimeSlot !== undefined) return runtimeSlot
  if (resolverSlot === undefined) throw new Error(UNCONFIGURED)

  assertSameEnv(env)
  const resolver = resolverSlot
  inFlight = (async () => {
    const resolved = await resolver(env)
    // The published runtime wins over a returned one, so every caller in the
    // isolate holds the same object — and therefore the same rate budgets and
    // the same registration map.
    const runtime = runtimeSlot ?? resolved
    if (!runtime) {
      throw new Error(RESOLVER_PUBLISHED_NOTHING)
    }
    return runtime
  })().catch((error: unknown) => {
    // Cleared on rejection, not latched. A boot that failed on a transient
    // condition — a binding not ready, a network blip in a provider — must be
    // retryable; a latched rejection would make one bad wake permanent for the
    // life of the isolate, and the agent would never recover without a deploy.
    inFlight = undefined
    resolvedEnvSeen = false
    throw error
  })

  return inFlight
}

/** Pin the isolate to one `env`, or refuse (RFC 0017 §6). */
function assertSameEnv(env: unknown): void {
  if (!resolvedEnvSeen) {
    resolvedEnv = env
    resolvedEnvSeen = true
    return
  }
  if (resolvedEnv !== env) {
    throw new Error(ENV_REPLACED)
  }
}

/**
 * Clear both slots and any resolution in flight. A test seam; nothing in an
 * application should call it.
 *
 * What needs clearing is what this module refuses or caches across boots: the
 * resolver slot, the in-flight promise, the pinned `env`.
 */
export function resetAgentRuntime(): void {
  runtimeSlot = undefined
  resolverSlot = undefined
  inFlight = undefined
  resolvedEnv = undefined
  resolvedEnvSeen = false
}

/**
 * Deep-freeze the registry a runtime hands out, before `agentsPlugin` publishes.
 *
 * The scope gate judges by the same `abilities` array the audit principal
 * reports, so frozen, a widening throws instead of reaching both. Not a
 * sandbox — in-process code shares this isolate — the accident, not the attack.
 */
export function freezeAgentRegistrations(
  registrations: Map<string, AgentRegistration>,
): ReadonlyMap<string, AgentRegistration> {
  for (const registration of registrations.values()) {
    Object.freeze(registration.abilities)
    if (registration.budget) Object.freeze(registration.budget)
    Object.freeze(registration)
  }
  return registrations
}

/**
 * The registration for one agent name, or `undefined`.
 *
 * A scan rather than a second index: the registry is keyed by export name
 * because that is what a running class knows about itself, and a handful of
 * agents does not earn a second map that could disagree with the first.
 */
export function findRegistrationByName(
  runtime: AgentRuntime,
  agentName: string,
): AgentRegistration | undefined {
  for (const registration of runtime.registrations.values()) {
    if (registration.name === agentName) return registration
  }
  return undefined
}
