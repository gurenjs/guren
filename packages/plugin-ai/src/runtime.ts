/**
 * What `aiPlugin()` settles for `appTools()`: the application's derived tools,
 * the audit trail and the approval queue (RFC 0029 §2.5). Bound under
 * {@link AI_RUNTIME_BINDING}, which is internal: `ServiceBindings` does not name it.
 */
import type {
  AgentApprovalRequest,
  AgentApprovalStore,
  AgentAuditEmitter,
  AgentAuditRecord,
  DerivedAgentTool,
} from '@guren/core'

export const AI_RUNTIME_BINDING = 'ai.runtime'

/** The same shapes `mcpPlugin` takes. */
export interface AiPluginConfig {
  /**
   * This plugin's own trail. Absent, `appTools()` records into the `agent.audit`
   * binding `mcpPlugin({ audit })` publishes, else only emits events. Configuring
   * both is refused at the first `appTools()` call.
   */
  audit?: { file?: string; days?: number } | { sink: (record: AgentAuditRecord) => void | Promise<void> }
  /** Absent, an `approval: 'required'` tool is refused fail-closed. */
  approvals?: {
    store: AgentApprovalStore
    notify: (request: AgentApprovalRequest) => void | Promise<void>
    ttlMs?: number
  }
}

export interface AiRuntime {
  /** Derived on first use and memoized: every provider has booted by then. */
  tools(): readonly DerivedAgentTool[]
  audit(): AgentAuditEmitter
  approvals?: AiPluginConfig['approvals']
}
