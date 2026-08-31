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
  const scope = gatePreflight(tool, abilities)
  if (!scope.allowed) return scope

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

/**
 * The scope half alone — what `guren.preflight` checks before rehearsing a
 * call to `tool` (RFC 0016 §5.4).
 *
 * Checking a tool requires the *same* scope as calling it. Without that, the
 * companion tool becomes a way to probe the authorization surface of tools
 * the token cannot call: an agent could learn which of them exist, which
 * validate what, and which are guarded by a policy, none of which it is
 * granted.
 *
 * The approval half is deliberately not applied. A tool declaring
 * `approval: 'required'` is exactly the one a caller most needs to rehearse —
 * "would this be accepted if it were approved?" is the question an approval
 * gate creates — and the rehearsal executes nothing, so answering it cannot
 * be the unapproved execution the fail-closed refusal exists to prevent.
 */
export function gatePreflight(tool: DerivedAgentTool, abilities: readonly string[]): GateVerdict {
  if (!scopesAllowTool(abilities, scopedShape(tool))) {
    return {
      allowed: false,
      reason: 'scope',
      message: `The token's scopes do not grant the tool "${tool.toolName}".`,
    }
  }

  return { allowed: true }
}

/** The two fields the scope grammar judges a tool by. */
export function scopedShape(tool: DerivedAgentTool): { name: string; readOnly: boolean } {
  return { name: tool.toolName, readOnly: tool.annotations.readOnlyHint }
}
