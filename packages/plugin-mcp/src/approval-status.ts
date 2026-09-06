/**
 * `guren.approval_status` — the approval-status companion tool (RFC 0016 §5.4
 * item 4). A call to an `approval: 'required'` tool comes back refused carrying
 * a request id; this is what the id is for. A meta-tool for the same protocol
 * reason `guren.preflight` is one: a status is not the gated route's output, and
 * MCP forbids a schema-declaring tool from answering with a different shape of
 * success. It owns no rule — the answer itself is `toApprovalStatusReport` in
 * `@guren/core`, shared with the durable surface, so a record this tool calls
 * "approved" cannot be one the gate refuses.
 */
import { APPROVAL_STATUS_TOOL_NAME } from '@guren/core'

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
    consumedAt: {
      type: 'string',
      description:
        'ISO 8601 instant the approval was spent. Approved and already spent: the one call it '
        + 'permitted has run — do not repeat the call. Absent while an approval is still available '
        + 'to use.',
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
