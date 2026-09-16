import {
  AGENT_AUDIT_BINDING,
  createAuditEmitter,
  definePlugin,
  deriveAgentTools,
  resolveAgentAuditSink,
  type AgentAuditEmitter,
  type Application,
  type DerivedAgentTool,
  type EventManager,
  type ServiceProviderConstructor,
} from '@guren/core'

import { AI_RUNTIME_BINDING, type AiPluginConfig, type AiRuntime } from './runtime'

export type { AiPluginConfig }

const factory = definePlugin<AiPluginConfig>({
  name: 'ai',
  register(): void {
    // Bound in `boot`: the sink resolves asynchronously, and nothing can call
    // `appTools()` before the application has booted.
  },
  async boot(container, config): Promise<void> {
    const events = container.has('events') ? container.make<EventManager>('events') : undefined
    const sink = config.audit ? await resolveAgentAuditSink(config.audit) : undefined
    const own = sink ? createAuditEmitter(sink, events) : undefined

    const app = container.make<Application>('app')
    let tools: readonly DerivedAgentTool[] | undefined
    // Cached only once the whole boot has settled: a provider booting after this
    // one may still register `.agent()` routes, and may build an agent before it does.
    let settled = false
    void app.booted().then(() => { settled = true }, () => {})

    const runtime: AiRuntime = {
      tools() {
        if (tools) return tools
        const derived = deriveAgentTools(app.router.definitions())
        for (const warning of derived.warnings) {
          console.warn(`[@guren/plugin-ai] ${warning}`)
        }
        if (settled) tools = derived.tools
        return derived.tools
      },
      // Read at first use, never in `boot`: `mcpPlugin` binds its emitter in its
      // own `boot`, so a check here would pass or fail by `providers` order.
      audit() {
        const bound = container.has(AGENT_AUDIT_BINDING)
        if (own) {
          if (bound) {
            throw new Error(
              'The agent audit trail is configured twice: aiPlugin({ audit }) and mcpPlugin({ audit }). '
              + 'Keep one; aiPlugin() records into mcpPlugin\'s trail when given none of its own.',
            )
          }
          return own
        }
        return bound
          ? container.make<AgentAuditEmitter>(AGENT_AUDIT_BINDING)
          : createAuditEmitter(undefined, events)
      },
      ...(config.approvals ? { approvals: config.approvals } : {}),
    }

    container.instance(AI_RUNTIME_BINDING, runtime)
  },
})

/**
 * Register in-process agents' audit trail and approval queue (RFC 0029 §2.5).
 * @example createApp({ config: [ai], providers: [aiPlugin({ approvals: { store, notify } })] })
 */
export function aiPlugin(config: AiPluginConfig = {}): ServiceProviderConstructor {
  return factory(config)
}
