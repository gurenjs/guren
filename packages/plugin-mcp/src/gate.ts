/**
 * The adapter-level checks a tool call passes before any HTTP request is
 * synthesized (RFC 0016 §5). Everything here maps onto one
 * `AgentToolDenialReason` — what happens *inside* the dispatched request
 * (validation, `Gate` policies) is the application's verdict, reported as an
 * invocation with its HTTP status, never re-judged here.
 *
 * Two functions, and the split between them is load-bearing.
 * {@link gateToolCall} is synchronous and free of side effects because
 * `tools/list` calls it for every tool on every listing: an approval check
 * that lived there would create a pending record and notify approvers once per
 * tool per client connect, which is the noisiest possible way to break a queue.
 * The approval half is {@link gateApproval}, reached only from the call path.
 */
import {
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
       * A machine-readable body riding alongside the message, rendered as the
       * error result's JSON content. Only the approval refusals carry one: a
       * caller told "this is pending" needs the id to poll with, and an agent
       * cannot be asked to parse it back out of English.
       *
       * An MCP `isError: true` result is delivered with its `content` intact —
       * measured against the SDK client, including for a tool that declares an
       * `outputSchema`, where neither a `-32600` nor structured-content
       * validation intervenes. That measurement is what makes a pending answer
       * expressible at all on this protocol; see RFC 0016 §5.4.
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
   * Mask a call's arguments for the record that a human will read and a store
   * will persist — `redactAgentArguments(args, tool.redact)`, the same walk
   * the audit trail uses, passed in so this module runs exactly one redaction
   * rule and defines none.
   */
  redact(args: Record<string, unknown>): Record<string, unknown>
  /**
   * Tell the approvers. Called once, only for a record this call created, and
   * **never awaited**: a notification channel that is down must not fail the
   * tool call or lose the record that is already persisted. Implementations
   * report their own failures; see the plugin's `notifyApprovers`.
   */
  notify(request: AgentApprovalRequest): void
}

/**
 * Scope and approval, in that order — a caller learns a tool needs approval
 * only once its token could invoke it at all, so an unauthorized probe cannot
 * map which tools are approval-gated.
 *
 * `tools:read`-style scopes judge the tool by its *resolved* read-only
 * annotation, the same value the catalog advertises.
 *
 * `approvalsConfigured` is the whole approval question asked here, and it is
 * asked synchronously because `tools/list` asks it: with a queue, an
 * approval-gated tool *is* callable — the call becomes a pending request,
 * which is the interaction the feature exists to offer — so it belongs in the
 * catalogue. Without one it is categorically uncallable, and listing it would
 * invite a call that can only ever be refused.
 */
export function gateToolCall(
  tool: DerivedAgentTool,
  abilities: readonly string[],
  options: { approvalsConfigured?: boolean } = {},
): GateVerdict {
  const scope = gatePreflight(tool, abilities)
  if (!scope.allowed) return scope

  if (tool.approval === 'required' && !options.approvalsConfigured) {
    // Fail closed, and say what is missing. An unconfigured queue must not
    // look like a working one — the same discipline the audit sink follows,
    // where an absent trail names the configuration line rather than reading
    // as an empty one.
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
 * The approval half, for a tool that declares `approval: 'required'` on a
 * server that has a queue (RFC 0016 §5.4 item 4).
 *
 * Four outcomes, from one lookup of the record matching this exact call — the
 * tool, the *raw* arguments' fingerprint, and the principal:
 *
 * 1. **Approved, unexpired, unspent, and this call wins `consume`** — allowed.
 * 2. **Pending** — refused, quoting the id of the record that already exists.
 *    No second record, no second notification: an agent that polls by
 *    re-calling the tool would otherwise create one of each per poll, and the
 *    approvers would be the ones who noticed.
 * 3. **Rejected** — refused, saying so, and again without a new record. A
 *    human answered this exact call; letting the next call re-ask would make a
 *    rejection cost nothing to overturn by retrying. The refusal reports
 *    `status: 'rejected'` distinctly so the caller can tell it from a pending
 *    wait it should keep polling. Once the record expires, asking again is a
 *    new question and is allowed to create a new record.
 * 4. **Anything else** — no match, an expired one, or an approval another call
 *    spent first — a new pending record, approvers notified, refused.
 *
 * **Consumption happens before dispatch, deliberately.** An approval is
 * permission for one attempt, not for one success. Consuming afterwards would
 * leave a window in which concurrent calls all pass the same check, and would
 * make a call that crashed mid-flight replayable — the side effect possibly
 * already taken, the approval still spendable. Burning an approval on a call
 * that then answers 500 is the cost, and it is the cheaper error: the operator
 * approves again, having been told what happened, instead of a destructive
 * call running twice on one approval.
 */
export async function gateApproval(
  tool: DerivedAgentTool,
  args: Record<string, unknown>,
  context: ApprovalGateContext,
): Promise<GateVerdict> {
  const fingerprint = await agentApprovalFingerprint(args)
  const principalKey = agentApprovalPrincipalKey(context.principal)
  const now = context.now()

  const existing = await context.store.findMatch({ tool: tool.toolName, fingerprint, principalKey })

  if (existing) {
    if (agentApprovalUsableAt(existing, now) && (await context.store.consume(existing.id))) {
      return { allowed: true }
    }

    const status = agentApprovalStatusAt(existing, now)
    if (status === 'pending') return pendingVerdict(tool, existing, 'pending')
    if (status === 'rejected') return rejectedVerdict(tool, existing)
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
  // Persisted first, then announced. A notification for a record that does not
  // exist sends an approver to a request they cannot answer; a record with no
  // notification is merely one nobody has looked at yet, which the status tool
  // and the approval UI both still show.
  await context.store.create(request)
  context.notify(request)

  return pendingVerdict(tool, request, 'created')
}

/**
 * The refusal for a call that is waiting on a human.
 *
 * Every refusal states that nothing was executed, in the message *and* in the
 * body. An agent reading only one of the two must not be left to infer it: the
 * result is an error, and "error" plus a tool name is exactly the shape an
 * agent retries.
 */
function pendingVerdict(
  tool: DerivedAgentTool,
  request: AgentApprovalRequest,
  origin: 'created' | 'pending',
): GateVerdict {
  return {
    allowed: false,
    reason: 'approval',
    message:
      `The tool "${tool.toolName}" requires approval. Nothing was executed. `
      + (origin === 'created'
        ? 'A request was created and the approvers have been notified. '
        : 'A request for this exact call is already waiting. ')
      + `Check it with ${APPROVAL_STATUS_TOOL_NAME} using requestId "${request.id}". `
      + 'Once it is approved, repeat this call with the same arguments to perform it.',
    body: {
      status: 'pending',
      requestId: request.id,
      tool: request.tool,
      requestedAt: request.requestedAt,
      expiresAt: request.expiresAt,
      executed: false,
      pollWith: APPROVAL_STATUS_TOOL_NAME,
    },
  }
}

function rejectedVerdict(tool: DerivedAgentTool, request: AgentApprovalRequest): GateVerdict {
  return {
    allowed: false,
    reason: 'approval',
    message:
      `The tool "${tool.toolName}" requires approval, and this exact call was rejected. Nothing was `
      + 'executed, and polling will not change that. Do not repeat the call with these arguments.',
    body: {
      status: 'rejected',
      requestId: request.id,
      tool: request.tool,
      requestedAt: request.requestedAt,
      expiresAt: request.expiresAt,
      executed: false,
      ...(request.resolvedAt ? { resolvedAt: request.resolvedAt } : {}),
    },
  }
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
 *
 * The cost differs by configuration, and both halves are small. With a queue,
 * such a tool is in `tools/list` anyway, so preflight reveals nothing the
 * catalogue does not. Without one it is absent — uncallable — so preflight
 * reveals that it exists and what it validates. That is not the leak the scope
 * rule guards against: the scope check above still ran, so the token holds
 * this very ability, and what the rule protects is knowledge of tools the
 * caller was never granted. Approval gates an ability the caller has; it is
 * not a boundary on what it may know. Revisit if approval ever comes to mean
 * "may not know this tool exists".
 *
 * Rehearsing is not requesting: preflight reaches this function and never
 * {@link gateApproval}, so checking an approval-gated tool creates no pending
 * record and notifies nobody.
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
