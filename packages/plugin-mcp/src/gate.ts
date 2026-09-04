/**
 * The adapter-level checks a tool call passes before any HTTP request is
 * synthesized (RFC 0016 §5); what happens *inside* the dispatched request is
 * the application's verdict, reported as an invocation with its HTTP status and
 * never re-judged here. {@link gateToolCall} is synchronous and free of side
 * effects because `tools/list` calls it for every tool on every listing — an
 * approval check there would create a pending record and notify approvers once
 * per tool per client connect. The approval half is {@link gateApproval},
 * reached only from the call path.
 */
import {
  agentApprovalExpiredAt,
  agentApprovalFingerprint,
  agentApprovalPrincipalKey,
  agentApprovalStatusAt,
  agentApprovalUsableAt,
  APPROVAL_STATUS_TOOL_NAME,
  buildAgentApprovalRequest,
  scopesAllowTool,
  type AgentApprovalRequest,
  type AgentApprovalStore,
  type AgentPrincipal,
  type AgentToolDenialReason,
  type DerivedAgentTool,
} from '@guren/core'

export type GateVerdict =
  | { allowed: true }
  | {
      allowed: false
      reason: AgentToolDenialReason
      message: string
      /**
       * Rendered as the error result's JSON content. Only approval refusals
       * carry one: a caller told "this is pending" needs the id to poll with.
       * Measured against the SDK client, an `isError: true` result keeps its
       * `content` even for a tool declaring an `outputSchema` — which is what
       * makes a pending answer expressible on this protocol (RFC 0016 §5.4).
       */
      body?: Record<string, unknown>
    }

/** What {@link gateApproval} needs to answer for one call. */
export interface ApprovalGateContext {
  store: AgentApprovalStore
  principal: AgentPrincipal | null
  /** How long a new pending record stays answerable. */
  ttlMs?: number
  now: () => Date
  /**
   * `redactAgentArguments(args, tool.redact)`, passed in so this module runs
   * exactly one redaction rule and defines none.
   */
  redact(args: Record<string, unknown>): Record<string, unknown>
  /**
   * Called once, only for a record this call created, and **never awaited**: a
   * channel that is down must not fail the call or lose the persisted record.
   */
  notify(request: AgentApprovalRequest): void
}

/**
 * Scope and approval, in that order — a caller learns a tool needs approval only
 * once its token could invoke it at all, so an unauthorized probe cannot map
 * which tools are approval-gated. `approvalsConfigured` is asked synchronously
 * because `tools/list` asks it: with a queue an approval-gated tool *is*
 * callable (the call becomes a pending request) and belongs in the catalogue;
 * without one it is uncallable, and listing it invites a certain refusal.
 */
export function gateToolCall(
  tool: DerivedAgentTool,
  abilities: readonly string[],
  options: { approvalsConfigured?: boolean } = {},
): GateVerdict {
  const scope = gatePreflight(tool, abilities)
  if (!scope.allowed) return scope

  if (tool.approval === 'required' && !options.approvalsConfigured) {
    // Fail closed, naming what is missing: an unconfigured queue must not look
    // like a working one.
    return {
      allowed: false,
      reason: 'approval',
      message:
        `The tool "${tool.toolName}" requires server-side approval, and this server has no `
        + 'approval queue configured. Nothing was executed. Configure one with '
        + 'mcpPlugin({ approvals: { store, notify } }).',
    }
  }

  return { allowed: true }
}

/**
 * The approval half, for a tool declaring `approval: 'required'` on a server
 * with a queue (RFC 0016 §5.4 item 4). One lookup on tool + *raw* arguments'
 * fingerprint + principal decides it: a pending or rejected match refuses
 * without filing a second record or notification (an agent polling by
 * re-calling would otherwise page the approvers once per poll), and a rejection
 * blocks only while its record is live. Consumption happens *before* dispatch —
 * an approval is permission for one attempt, not one success, so consuming
 * after would let concurrent calls pass the same check and make a call that
 * crashed mid-flight replayable.
 */
export async function gateApproval(
  tool: DerivedAgentTool,
  args: Record<string, unknown>,
  context: ApprovalGateContext,
): Promise<GateVerdict> {
  if (context.principal === null) {
    // An approval is granted to *someone* and spent by matching that someone.
    // `agentApprovalPrincipalKey` answers `'anonymous'` for every unidentified
    // caller, so one could spend an approval granted to another and read their
    // pending actions through `guren.approval_status`.
    return {
      allowed: false,
      reason: 'approval',
      message:
        `The tool "${tool.toolName}" requires approval, and this request carries no identified `
        + 'caller. An approval is granted to a principal and spent by one, so it cannot be bound '
        + 'to an anonymous call. Nothing was executed and no request was recorded.',
    }
  }

  const fingerprint = await agentApprovalFingerprint(args)
  const principalKey = agentApprovalPrincipalKey(context.principal)
  const now = context.now()

  const existing = await context.store.findMatch({ tool: tool.toolName, fingerprint, principalKey })

  if (existing) {
    if (agentApprovalUsableAt(existing, now)) {
      if (await context.store.consume(existing.id)) {
        return { allowed: true }
      }
      // Another call spent this approval between the lookup and here. Refused
      // without filing a new request: `existing` is the pre-race copy, so
      // falling through would read it as "no usable match" and open a fresh
      // record and notification for every losing call.
      return spentVerdict(tool, existing)
    }

    const status = agentApprovalStatusAt(existing, now)
    if (status === 'pending') return pendingVerdict(tool, existing, 'pending')
    // Expiry is asked separately, and only here. `agentApprovalStatusAt` reports
    // a rejection forever, which is right for `guren.approval_status` but as a
    // *block* would denylist that exact call for that principal permanently,
    // with no remedy short of deleting the row.
    if (status === 'rejected' && !agentApprovalExpiredAt(existing, now)) {
      return rejectedVerdict(tool, existing)
    }
  }

  const request = buildAgentApprovalRequest(
    {
      tool: tool.toolName,
      input: context.redact(args),
      fingerprint,
      principal: context.principal,
      ttlMs: context.ttlMs,
    },
    now,
  )
  // Persisted first, then announced: a notification for a record that does not
  // exist sends an approver to a request they cannot answer.
  await context.store.create(request)
  context.notify(request)

  return pendingVerdict(tool, request, 'created')
}

/**
 * One builder for the three refusals, so the fields an agent parses cannot come
 * to differ between them. Every refusal states that nothing was executed in the
 * message *and* the body: an error plus a tool name is exactly the shape an
 * agent retries.
 */
function approvalRefusal(
  status: 'pending' | 'rejected' | 'spent',
  message: string,
  request: AgentApprovalRequest,
  extra: Record<string, unknown> = {},
): GateVerdict {
  return {
    allowed: false,
    reason: 'approval',
    message,
    body: {
      status,
      requestId: request.id,
      tool: request.tool,
      requestedAt: request.requestedAt,
      expiresAt: request.expiresAt,
      executed: false,
      ...extra,
    },
  }
}

/**
 * The refusal for a call that is waiting on a human. `pollWith` rides only
 * here: this is the one answer a caller should come back to, where a rejection
 * is told not to poll and a spent approval to ask again.
 */
function pendingVerdict(
  tool: DerivedAgentTool,
  request: AgentApprovalRequest,
  origin: 'created' | 'pending',
): GateVerdict {
  return approvalRefusal(
    'pending',
    `The tool "${tool.toolName}" requires approval. Nothing was executed. `
    + (origin === 'created'
      ? 'A request was created and the approvers have been notified. '
      : 'A request for this exact call is already waiting. ')
    + `Check it with ${APPROVAL_STATUS_TOOL_NAME} using requestId "${request.id}". `
    + 'Once it is approved, repeat this call with the same arguments to perform it.',
    request,
    { pollWith: APPROVAL_STATUS_TOOL_NAME },
  )
}

/** A call a human answered "no" to, reported distinctly from a pending wait. */
function rejectedVerdict(tool: DerivedAgentTool, request: AgentApprovalRequest): GateVerdict {
  return approvalRefusal(
    'rejected',
    `The tool "${tool.toolName}" requires approval, and this exact call was rejected. Nothing was `
    + 'executed, and polling will not change that. Do not repeat the call with these arguments.',
    request,
    request.resolvedAt ? { resolvedAt: request.resolvedAt } : {},
  )
}

/**
 * An approval another call spent first — its own answer rather than a fresh
 * request: the loser of the race was not refused for want of approval, so
 * telling it to ask again is right, filing a request and paging a human is not.
 */
function spentVerdict(tool: DerivedAgentTool, request: AgentApprovalRequest): GateVerdict {
  return approvalRefusal(
    'spent',
    `The tool "${tool.toolName}" requires approval, and the approval for this exact call was `
    + 'already used by another call. Nothing was executed. Ask again to request a new one.',
    request,
  )
}

/**
 * The scope half alone — what `guren.preflight` checks before rehearsing a call
 * (RFC 0016 §5.4). Checking requires the *same* scope as calling, or the
 * companion tool becomes a way to probe the authorization surface of tools the
 * token cannot call. The approval half is deliberately not applied: a rehearsal
 * executes nothing, and approval gates an ability the caller has rather than
 * knowledge that it exists. Preflight never reaches {@link gateApproval}, so it
 * creates no pending record and notifies nobody.
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
