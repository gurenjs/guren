/**
 * `agentsPlugin` (RFC 0017 §3): the boot half of the durable agent runtime.
 *
 * It registers no route — agents are not reached through the application, they
 * *reach into* it. It settles once what a Durable Object cannot work out for
 * itself (which classes are agents, what each may call, where the trail goes)
 * and publishes it on the {@link configureAgentRuntime} latch.
 *
 * Bun-safe: nothing here imports `agents`.
 */
import {
  AGENT_AUDIT_BINDING,
  createAuditEmitter,
  definePlugin,
  deriveAgentTools,
  expandToolScopes,
  parseToolScope,
} from '@guren/core'
import type {
  AgentAuditEmitter,
  Application,
  EventManager,
  ScopedTool,
  ServiceProviderConstructor,
} from '@guren/core'

import {
  describeAgentsConfigProblems,
  validateAgentsConfig,
  type AgentsConfig,
} from './config'
import { configureAgentRuntime, freezeAgentRegistrations, type AgentRegistration } from './latch'

export type AgentsPluginConfig = AgentsConfig

const factory = definePlugin<AgentsPluginConfig>({
  name: 'agents',
  register(): void {
    // Nothing to bind. The runtime is settled in `boot`, because it needs the
    // booted router's definitions and whatever audit emitter another plugin
    // may have published.
  },
  async boot(container, config): Promise<void> {
    const problems = validateAgentsConfig(config)
    if (problems.length > 0) {
      throw new Error(
        'config/agents.ts is not a valid agent registry:\n'
        + describeAgentsConfigProblems(problems),
      )
    }

    const app = container.make<Application>('app')

    const { tools, warnings } = deriveAgentTools(app.router.definitions())
    for (const warning of warnings) {
      console.warn(`[@guren/plugin-agents] ${warning}`)
    }

    const scoped: ScopedTool[] = tools.map((tool) => ({
      name: tool.toolName,
      readOnly: tool.annotations.readOnlyHint,
    }))
    const toolNames = new Set(scoped.map((tool) => tool.name))

    const registrations = new Map<string, AgentRegistration>()
    for (const [name, registration] of Object.entries(config.agents)) {
      // Expanded here, against the route graph as it actually booted — the
      // same expansion `guren check` does against the source, so the two fail
      // closed on drift rather than one of them inventing a tool.
      const allowed = expandToolScopes(registration.scopes, scoped)

      for (const scope of registration.scopes) {
        const parsed = parseToolScope(scope)
        if (parsed?.kind === 'tool' && !toolNames.has(parsed.name)) {
          // A warning, not a throw. A route can be registered by a plugin that
          // boots after this one, and refusing to boot over a name this
          // instant cannot see would make provider order a correctness
          // question. The scope gate is fail-closed either way: an ability
          // naming no tool grants nothing.
          console.warn(
            `[@guren/plugin-agents] The agent "${name}" is scoped to the tool "${parsed.name}", `
            + 'which no route in this application declares. The scope grants nothing. '
            + 'Run `guren check` to see the tools this application exposes.',
          )
        }
      }

      registrations.set(registration.export, {
        name,
        abilities: allowed.map((tool) => `tool:${tool}`),
        ...(registration.budget ? { budget: registration.budget } : {}),
      })
    }

    // Resolved at first use, never here. The binding is published by another
    // plugin's `boot` — `mcpPlugin({ audit })` binds it from its own — so
    // reading the container here makes `providers` order decide whether the
    // durable surface records at all. Every `boot` has completed before an
    // agent's first tool call, which is when the answer becomes stable.
    let memoized: AgentAuditEmitter | undefined
    const audit = (): AgentAuditEmitter => {
      if (memoized) return memoized
      if (container.has(AGENT_AUDIT_BINDING)) {
        // Memoized only on a *hit*. Caching the fallback would pin "there is no
        // trail" for the life of the process on the strength of one early look
        // — and the binding's whole purpose is to be published by another
        // plugin, possibly later than the first thing that asks.
        memoized = container.make<AgentAuditEmitter>(AGENT_AUDIT_BINDING)
        return memoized
      }
      // No binding yet: records go nowhere and the *events* are still emitted,
      // which is exactly what an app with no configured sink sees on every
      // other surface. Rebuilt each time, so a binding published later wins.
      return createAuditEmitter(
        undefined,
        container.has('events') ? container.make<EventManager>('events') : undefined,
      )
    }

    configureAgentRuntime({
      // Not `app` itself: this hook runs inside `bootAll()`, so every provider
      // after it is still unbooted and a call dispatched now re-enters a half
      // assembled app. Awaiting `booted()` is "published" vs "usable".
      app: {
        fetch: async (request, env, executionCtx) => {
          await app.booted()
          return app.fetch(request, env, executionCtx)
        },
      },
      tools,
      // Frozen before it is published: the `abilities` array the scope gate
      // judges by is the same object the audit principal reports, and neither
      // may be widened afterwards.
      registrations: freezeAgentRegistrations(registrations),
      audit,
      ...(config.approvals ? { approvals: config.approvals } : {}),
    })
  },
})

/**
 * Register the durable agent runtime.
 * @example
 * `createApp({ providers: [agentsPlugin(agents)] })`, with `agents` the default
 * export of `config/agents.ts`.
 */
export function agentsPlugin(config: AgentsPluginConfig): ServiceProviderConstructor {
  return factory(config)
}
