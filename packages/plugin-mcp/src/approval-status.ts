/**
 * `guren.approval_status` — the approval-status companion tool (RFC 0016
 * §5.4 item 4).
 *
 * A call to an `approval: 'required'` tool comes back refused, carrying a
 * request id. This is what the id is for: the caller asks what became of it,
 * and repeats the original call once the answer is `approved`.
 *
 * It is a meta-tool for the same protocol reason `guren.preflight` is one. A
 * status is not the gated route's output, and MCP forbids a tool advertising
 * an `outputSchema` from answering with a different shape of success — so the
 * answer needs a tool with a schema of its own, and one for the whole
 * catalogue rather than one per gated tool.
 *
 * The module owns the tool's advertised schemas and the translation of a
 * stored record into an answer. It owns no rule: expiry is
 * `agentApprovalStatusAt`, visibility is `agentApprovalVisibleTo`, both in
 * `@guren/core` beside the store interface, because the gate reads the same
 * two and a second copy here is how a record this tool calls "approved" comes
 * to be one the gate refuses.
 */
import {
  agentApprovalStatusAt,
  agentApprovalVisibleTo,
  APPROVAL_STATUS_TOOL_NAME,
  type AgentApprovalRequest,
  type AgentPrincipal,
} from '@guren/core'

/** A JSON Schema object as MCP advertises it. */
type McpObjectSchema = { type: 'object'; [key: string]: unknown }

const APPROVAL_STATUS_INPUT_SCHEMA: McpObjectSchema = {
  type: 'object',
  properties: {
    requestId: {
      type: 'string',
      description:
        'The requestId from the refusal that created the request, exactly as it was reported.',
    },
  },
  required: ['requestId'],
}

/**
 * `additionalProperties` is deliberately unset, for the reason
 * `PREFLIGHT_OUTPUT_SCHEMA` states: the SDK client validates
 * `structuredContent` against this schema, and a closed object would turn any
 * later field into a `-32602` for a client pinned to an older server.
 */
const APPROVAL_STATUS_OUTPUT_SCHEMA: McpObjectSchema = {
  type: 'object',
  properties: {
    requestId: { type: 'string', description: 'The request that was asked about.' },
    status: {
      type: 'string',
      enum: ['pending', 'approved', 'rejected', 'expired'],
      description:
        'pending: waiting on a human. approved: repeat the original call, with the same arguments, '
        + 'to perform it once. rejected: a human refused this call; do not repeat it. expired: the '
        + 'window closed unanswered; repeating the original call asks again.',
    },
    tool: { type: 'string', description: 'The tool the request would run.' },
    requestedAt: { type: 'string', description: 'ISO 8601 instant the request was created.' },
    expiresAt: {
      type: 'string',
      description: 'ISO 8601 instant past which the request authorizes nothing.',
    },
    resolvedAt: {
      type: 'string',
      description: 'ISO 8601 instant a human answered. Absent while pending.',
    },
    resolvedBy: {
      type: 'string',
      description: 'Who answered, in the application\'s own vocabulary. Absent while pending.',
    },
    executed: {
      type: 'boolean',
      description:
        'Always false. Reading a status never performs the call — an approved request still has to '
        + 'be called again.',
    },
  },
  required: ['requestId', 'status', 'tool', 'requestedAt', 'expiresAt', 'executed'],
}

/**
 * The tool as `tools/list` advertises it.
 *
 * The description says what an agent should *do* with each answer, not only
 * what the field means: the whole point of the tool is to end a poll loop, and
 * a client that reads "approved" without being told to repeat the original
 * call will sit on it.
 */
export function describeApprovalStatusTool(): {
  name: string
  description: string
  inputSchema: McpObjectSchema
  outputSchema: McpObjectSchema
  annotations: { readOnlyHint: true; destructiveHint: false; idempotentHint: true }
} {
  return {
    name: APPROVAL_STATUS_TOOL_NAME,
    description:
      'Check what became of an approval request this caller created. Tools that require approval '
      + 'refuse the first call and return a requestId; pass it here to learn whether a human has '
      + 'approved it. Reading a status performs nothing — once the answer is "approved", repeat the '
      + 'original tool call with the same arguments to perform it, once.',
    inputSchema: APPROVAL_STATUS_INPUT_SCHEMA,
    outputSchema: APPROVAL_STATUS_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }
}

/** The arguments of one status call, once read. */
export type ApprovalStatusRequest = { requestId: string } | { error: string }

/**
 * Read `{ requestId }` off a raw call.
 *
 * Checked here for the reason `readPreflightArguments` checks its two: the
 * low-level `Server` hands arguments through unvalidated, and this argument
 * decides *which record* is addressed.
 */
export function readApprovalStatusArguments(
  args: Record<string, unknown>,
): ApprovalStatusRequest {
  const requestId = args.requestId
  if (typeof requestId !== 'string' || requestId === '') {
    return {
      error:
        `${APPROVAL_STATUS_TOOL_NAME} needs a "requestId" argument naming the request to check, as a `
        + 'non-empty string.',
    }
  }
  return { requestId }
}

/** One answer, as it rides in `structuredContent`. */
export interface ApprovalStatusReport {
  [key: string]: unknown
  requestId: string
  status: string
  tool: string
  requestedAt: string
  expiresAt: string
  executed: false
  resolvedAt?: string
  resolvedBy?: string
}

/**
 * The one message for "there is no such request *for you*".
 *
 * A single function, called from both branches, because the two answers must
 * be **indistinguishable**: an unknown id and another principal's id are the
 * same answer, byte for byte. Any difference — a distinct message, a different
 * result shape, a field one carries and the other does not — turns the tool
 * into a way to enumerate other principals' pending actions, which is exactly
 * what the scope rule forbids. Building the two messages separately is how
 * that difference gets reintroduced by a later edit to one of them, so there
 * is only one to edit.
 *
 * The audit trail is the place the distinction *is* kept: the operator should
 * be able to see that a caller asked after someone else's request. The caller
 * may not.
 */
export function approvalStatusNotFoundMessage(requestId: string): string {
  return `No approval request with id "${requestId}" was made by this caller.`
}

export type ApprovalStatusOutcome =
  | { report: ApprovalStatusReport }
  /**
   * Unknown, or not this caller's — one answer to the caller. See above.
   *
   * `foreign` is the half the *operator* gets and the caller does not: the
   * record exists and belongs to someone else. Without it, the claim above —
   * that the audit trail keeps the distinction the caller is denied — is not
   * true of anything, because both cases reach the audit event as an identical
   * 404. It must never reach the result: the message is the same either way,
   * and this rides beside it rather than in it.
   */
  | { notFound: string; foreign: boolean }

/**
 * Read a stored record as an answer for `principal` at `now`.
 *
 * `record === null` and "not visible to this principal" converge on the same
 * branch on purpose, and they converge *here* rather than at two call sites,
 * so the sameness is structural rather than a thing two branches happen to
 * agree on today.
 */
export function toApprovalStatusReport(
  requestId: string,
  record: AgentApprovalRequest | null,
  principal: AgentPrincipal | null,
  now: Date,
): ApprovalStatusOutcome {
  if (!record || !agentApprovalVisibleTo(record, principal)) {
    return { notFound: approvalStatusNotFoundMessage(requestId), foreign: record !== null }
  }

  return {
    report: {
      requestId: record.id,
      status: agentApprovalStatusAt(record, now),
      tool: record.tool,
      requestedAt: record.requestedAt,
      expiresAt: record.expiresAt,
      executed: false,
      ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}),
      ...(record.resolvedBy ? { resolvedBy: record.resolvedBy } : {}),
    },
  }
}
