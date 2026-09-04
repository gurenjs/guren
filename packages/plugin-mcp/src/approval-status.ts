/**
 * `guren.approval_status` — the approval-status companion tool (RFC 0016 §5.4
 * item 4). A call to an `approval: 'required'` tool comes back refused carrying
 * a request id; this is what the id is for. A meta-tool for the same protocol
 * reason `guren.preflight` is one: a status is not the gated route's output, and
 * MCP forbids a schema-declaring tool from answering with a different shape of
 * success. It owns no rule — expiry is `agentApprovalStatusAt` and visibility
 * `agentApprovalVisibleTo`, the same two the gate reads, so a record this tool
 * calls "approved" cannot be one the gate refuses.
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
 * `PREFLIGHT_OUTPUT_SCHEMA` states: a closed object would turn any later field
 * into a `-32602` for a client pinned to an older server.
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
 * The tool as `tools/list` advertises it. The description says what an agent
 * should *do* with each answer: a client that reads "approved" without being
 * told to repeat the original call will sit on it.
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
 * Read `{ requestId }` off a raw call. The low-level `Server` hands arguments
 * through unvalidated, and this one decides *which record* is addressed.
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
 * The one message for "there is no such request *for you*". One function for
 * both branches because an unknown id and another principal's id must be the
 * same answer byte for byte: any difference turns the tool into a way to
 * enumerate other principals' pending actions. The audit trail is where the
 * distinction is kept, for the operator.
 */
export function approvalStatusNotFoundMessage(requestId: string): string {
  return `No approval request with id "${requestId}" was made by this caller.`
}

export type ApprovalStatusOutcome =
  | { report: ApprovalStatusReport }
  /**
   * Unknown, or not this caller's — one answer to the caller. `foreign` is the
   * half the *operator* gets: it rides beside the message, for the audit event,
   * and must never reach the result.
   */
  | { notFound: string; foreign: boolean }

/**
 * Read a stored record as an answer for `principal` at `now`. `record === null`
 * and "not visible to this principal" converge here rather than at two call
 * sites, so their sameness is structural.
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
