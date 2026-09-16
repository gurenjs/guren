/**
 * The `audit` option every agent surface plugin takes (`mcpPlugin`, `aiPlugin`),
 * and the one rule turning it into a sink. Absent from `@guren/server/agent`:
 * the file branch writes to disk, which a browser dispatcher has no use for.
 */
import { DEFAULT_AGENT_AUDIT_PATH } from './audit'
import type { AgentAuditSink } from './audit-emitter'

/**
 * `file` is a *base* path: the trail lands in `agent-audit-YYYY-MM-DD.log`
 * beside it, rotated daily, `days` of them kept. A `sink` replaces the file.
 */
export type AgentAuditConfig = { file?: string; days?: number } | { sink: AgentAuditSink }

/**
 * `{ file }` is built behind a dynamic `import()` so an application that
 * configured its own `sink` never evaluates the filesystem module.
 */
export async function resolveAgentAuditSink(config: AgentAuditConfig): Promise<AgentAuditSink> {
  if ('sink' in config) return config.sink

  const { createFileAuditSink } = await import('./audit-file')
  return createFileAuditSink(config.file ?? DEFAULT_AGENT_AUDIT_PATH, config.days)
}
