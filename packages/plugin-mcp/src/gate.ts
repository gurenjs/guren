/**
 * The adapter-level checks a tool call passes before any HTTP request is
 * synthesized (RFC 0016 §5). Everything here maps onto one
 * `AgentToolDenialReason` — what happens *inside* the dispatched request
 * (validation, `Gate` policies) is the application's verdict, reported as an
 * invocation with its HTTP status, never re-judged here.
 */
import { scopesAllowTool, type AgentToolDenialReason, type DerivedAgentTool } from '@guren/core'

export type GateVerdict =
  | { allowed: true }
  | { allowed: false; reason: AgentToolDenialReason; message: string }

/**
 * Scope and approval, in that order — a caller learns a tool needs approval
 * only once its token could invoke it at all, so an unauthorized probe cannot
 * map which tools are approval-gated.
 *
 * `tools:read`-style scopes judge the tool by its *resolved* read-only
 * annotation, the same value the catalog advertises.
 */
export function gateToolCall(tool: DerivedAgentTool, abilities: readonly string[]): GateVerdict {
  if (!scopesAllowTool(abilities, scopedShape(tool))) {
    return {
      allowed: false,
      reason: 'scope',
      message: `The token's scopes do not grant the tool "${tool.toolName}".`,
    }
  }

  if (tool.approval === 'required') {
    // Fail-closed until the approval queue ships (RFC 0016 Phase 2.5): a
    // tool that declares it must not execute without server-side approval
    // is refused, never quietly executed.
    return {
      allowed: false,
      reason: 'approval',
      message:
        `The tool "${tool.toolName}" requires server-side approval, and this server has no `
        + 'approval queue configured. Approval support ships in a later release.',
    }
  }

  return { allowed: true }
}

/** The two fields the scope grammar judges a tool by. */
export function scopedShape(tool: DerivedAgentTool): { name: string; readOnly: boolean } {
  return { name: tool.toolName, readOnly: tool.annotations.readOnlyHint }
}
