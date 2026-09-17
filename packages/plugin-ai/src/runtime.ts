/**
 * What `aiPlugin()` settles for `appTools()`: the application's derived tools,
 * the audit trail and the approval queue (RFC 0029 §2.5). Bound under
 * {@link AI_RUNTIME_BINDING}, which is internal: `ServiceBindings` does not name it.
 */
import type {
  AgentApprovalRequest,
  AgentApprovalStore,
  AgentAuditEmitter,
  AgentAuditConfig,
  DerivedAgentTool,
} from '@guren/core'

import type { AgentClass } from './agent'

export const AI_RUNTIME_BINDING = 'ai.runtime'

/** The same shapes `mcpPlugin` takes. */
export interface AiPluginConfig {
  /**
   * This plugin's own trail. Absent, `appTools()` records into the `agent.audit`
   * binding `mcpPlugin({ audit })` publishes, else only emits events. Configuring
   * both is refused at the first `appTools()` call.
   */
  audit?: AgentAuditConfig
  /** Absent, an `approval: 'required'` tool is refused fail-closed. */
  approvals?: {
    store: AgentApprovalStore
    notify: (request: AgentApprovalRequest) => void | Promise<void>
    ttlMs?: number
  }
  /**
   * The agents a worker may run: `queue()` resolves the class back from its `agentName`,
   * never from the class name, which a deploy may rename or a minifier mangle (RFC 0029 §6).
   */
  agents?: readonly AgentClass[]
}

export interface AiRuntime {
  /** Derived on use; memoized once the application has finished booting. */
  tools(): readonly DerivedAgentTool[]
  audit(): AgentAuditEmitter
  approvals?: AiPluginConfig['approvals']
  /** `aiPlugin({ agents })`, keyed by `agentName`. */
  agents: ReadonlyMap<string, AgentClass>
}
