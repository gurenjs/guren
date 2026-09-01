/**
 * `guren.preflight` — the preflight companion tool (RFC 0016 §5.4).
 *
 * Preflight cannot be an argument of the tool being checked on this protocol.
 * MCP forbids a tool from returning a different *shape* of success: one
 * advertising an `outputSchema` must answer with `structuredContent`
 * conforming to it unless the result is an error (the SDK client throws
 * `-32600` for a conforming-schema tool that returns plain content, `-32602`
 * for structured content of the wrong shape). A verdict conforms to no
 * route's output, and reporting "allowed" as an error would be worse than not
 * offering preflight at all.
 *
 * So the verdict gets a tool of its own, with its own output schema — and
 * exactly one for the whole catalogue, taking the target tool's name as an
 * argument. Per-tool companions were the obvious alternative and were
 * rejected: they double the catalogue, which collides with §5.5's own
 * catalogue-quality rule (tool-count threshold, description lint), and
 * clients reward small catalogues.
 *
 * Nothing here re-implements a check. The module owns two things only: the
 * tool's advertised schemas, and the translation of what the router's
 * preflight seam answered into a verdict. Scope is `gate.ts`'s, the checks
 * themselves are the application's, reached by dispatching the real request
 * with `BuildToolRequestOptions.preflight`.
 */
import { PREFLIGHT_TOOL_NAME, type ToolCallOutcome } from '@guren/core'

/** A JSON Schema object as MCP advertises it. */
type McpObjectSchema = { type: 'object'; [key: string]: unknown }

/**
 * What a preflight call takes: the tool to check, and the arguments the call
 * would have passed.
 *
 * `input` is an open object because it stands in for *another tool's* input
 * schema, which this one cannot know at advertisement time. The arguments are
 * not validated here either — they are handed to the route, whose own
 * validation is the answer the caller asked for.
 */
const PREFLIGHT_INPUT_SCHEMA: McpObjectSchema = {
  type: 'object',
  properties: {
    tool: {
      type: 'string',
      description: 'Name of the tool to check, exactly as tools/list reports it.',
    },
    input: {
      type: 'object',
      description:
        'The arguments the call would pass. Omit to check a call with no arguments — the same '
        + 'thing an empty object means.',
    },
  },
  required: ['tool'],
}

/**
 * The verdict.
 *
 * Two fields are deliberately *not* required, because the seam does not
 * always get to produce them. `validated` and `unverified` come from the seam
 * itself, which sits last in the chain: a call refused by the middleware in
 * front of it (401, 403) never reaches the seam, so there is nothing to
 * report about what a further check would have covered. Emitting `[]` there
 * would read as "nothing went unverified", which is a claim about checks that
 * were never reached.
 *
 * `additionalProperties` is deliberately unset: the SDK client validates
 * `structuredContent` against this schema, and a closed object would turn any
 * later field into a `-32602` for clients that pinned an older server.
 */
const PREFLIGHT_OUTPUT_SCHEMA: McpObjectSchema = {
  type: 'object',
  properties: {
    tool: { type: 'string', description: 'The tool that was checked.' },
    allowed: {
      type: 'boolean',
      description:
        'Whether a real call would have reached the handler. False means the request was refused '
        + 'before it — by authentication, authorization, or the contract validation below.',
    },
    status: {
      type: 'integer',
      description: 'HTTP status the rehearsed request resolved to. 200 for an allowed verdict.',
    },
    message: { type: 'string', description: 'Human-readable summary of the verdict.' },
    validated: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Which of the route\'s contracts were checked: params, query, body. Present only when the '
        + 'request reached the preflight seam.',
    },
    unverified: {
      type: 'array',
      items: { type: 'string' },
      description:
        'What an allowed verdict could not check. "authorization" means the route carries no '
        + 'authorization middleware, so any check inside the handler itself was never evaluated. '
        + 'Present only when the request reached the preflight seam.',
    },
    errors: {
      description:
        'Validation errors, as the application reported them — field name to messages, for a '
        + 'contract failure. Absent when the refusal was not a validation one.',
    },
  },
  required: ['tool', 'allowed', 'status', 'message'],
}

/**
 * The tool as `tools/list` advertises it.
 *
 * The description says what the tool does *and* that it executes nothing —
 * an agent reading a catalogue decides from this line alone whether asking is
 * safe, and "preflight" is not self-explanatory to a client that has never
 * seen this framework.
 */
export function describePreflightTool(): {
  name: string
  description: string
  inputSchema: McpObjectSchema
  outputSchema: McpObjectSchema
  annotations: { readOnlyHint: true; destructiveHint: false; idempotentHint: true }
} {
  return {
    name: PREFLIGHT_TOOL_NAME,
    description:
      'Check whether a call to another tool would be allowed, without performing it. Runs that '
      + 'tool\'s authentication, authorization and input validation and then stops before the '
      + 'handler, so the action itself does not happen — though the route\'s middleware does run, '
      + 'and anything it does of its own accord still takes effect. Returns a verdict: allowed, '
      + 'plus the validation errors when it is not.',
    inputSchema: PREFLIGHT_INPUT_SCHEMA,
    outputSchema: PREFLIGHT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }
}

/** The arguments of one preflight call, once read. */
export type PreflightRequest =
  | { name: string; input: Record<string, unknown> }
  /** The arguments were not usable; the text names what was wrong. */
  | { error: string }

/**
 * Read `{ tool, input }` off a raw call.
 *
 * The client already saw the input schema, but nothing obliges it to have
 * honoured one — the low-level `Server` hands arguments through unvalidated
 * (see `server.ts` on why that is deliberate), and this tool's arguments are
 * the one place on this surface where an unchecked value decides *which*
 * tool is addressed. So the two fields are checked here, and only these two.
 */
export function readPreflightArguments(args: Record<string, unknown>): PreflightRequest {
  const name = args.tool
  if (typeof name !== 'string' || name === '') {
    return {
      error:
        `${PREFLIGHT_TOOL_NAME} needs a "tool" argument naming the tool to check, as a non-empty `
        + 'string.',
    }
  }

  const input = args.input
  if (input === undefined || input === null) {
    return { name, input: {} }
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return {
      error:
        `${PREFLIGHT_TOOL_NAME} takes the checked tool's arguments as an "input" object; received `
        + `${Array.isArray(input) ? 'an array' : typeof input}.`,
    }
  }

  return { name, input: input as Record<string, unknown> }
}

/** One verdict, as it rides in `structuredContent`. */
export interface PreflightVerdict {
  [key: string]: unknown
  tool: string
  allowed: boolean
  status: number
  message: string
  validated?: string[]
  unverified?: string[]
  errors?: unknown
}

export type PreflightOutcome =
  | { verdict: PreflightVerdict }
  /**
   * The app answered the rehearsal with something that is not a verdict,
   * which means the handler ran. The text explains it; the caller turns it
   * into an error result rather than a verdict.
   */
  | { executed: string }

/**
 * Read the dispatched response as a verdict.
 *
 * The three branches are settled by where the seam sits, not by guesswork.
 * It is mounted last before the handler and answers unconditionally once the
 * header is present — a route with no schemas still answers 200 with
 * `validated: []`. So:
 *
 * - The verdict marker is an allowed verdict, and the handler did not run.
 *   The marker is `ToolCallOutcome.preflightVerdict`, which `mapToolResponse`
 *   set from the response header. Reading a `preflight` field out of the body
 *   instead would be a second, weaker copy of the same judgement, and the one
 *   that gets it wrong for a route whose own output carries that field.
 * - Any 4xx/5xx can only have come from a gate *in front of* the seam or from
 *   the seam's own contract validation, so it is a refusal and, either way,
 *   nothing ran. That is `allowed: false` — a successful answer to the
 *   question, which is why it is not an error result.
 * - Anything else (a 2xx that is not a verdict, a 204, a redirect) means the
 *   request reached a handler: only a route without the seam can produce one,
 *   and a controller can answer any of those. Reported as an error, never as
 *   a rehearsal — a redirect from an auth middleware and a redirect from a
 *   controller that just created a record are indistinguishable here, and
 *   calling the second one "not allowed" would describe a write that
 *   happened as a write that did not.
 */
export function toPreflightVerdict(toolName: string, outcome: ToolCallOutcome): PreflightOutcome {
  const parsed = parseContent(outcome)

  if (!outcome.isError && outcome.preflightVerdict === true) {
    // The header settled *that* this is a verdict; the body still crossed an
    // HTTP boundary, so its fields are read as defensively as any other.
    const body = isRecord(parsed) ? parsed : {}
    const validated = stringList(body.validated)
    const unverified = stringList(body.unverified)
    return {
      verdict: {
        tool: toolName,
        allowed: true,
        status: outcome.status,
        message:
          typeof body.message === 'string'
            ? body.message
            : `A call to "${toolName}" would be allowed. The handler did not run.`,
        ...(validated ? { validated } : {}),
        ...(unverified ? { unverified } : {}),
      },
    }
  }

  if (outcome.isError) {
    // The application's own error body, as the exception handler wrote it:
    // `{ message, errors? }` for an `HttpException`, which covers the 422 a
    // contract failure produces and the 401/403 a guard does. Anything else
    // (a plain-text body, an adapter refusal before HTTP) still has text, and
    // that text is the message.
    const message = isRecord(parsed) && typeof parsed.message === 'string'
      ? parsed.message
      : (outcome.content[0]?.text ?? `HTTP ${outcome.status}`)

    return {
      verdict: {
        tool: toolName,
        allowed: false,
        status: outcome.status,
        message,
        ...(isRecord(parsed) && parsed.errors !== undefined ? { errors: parsed.errors } : {}),
      },
    }
  }

  return {
    executed: `The route behind "${toolName}" did not answer the preflight with a verdict (HTTP `
      + `${outcome.status}), which means its handler ran. Nothing was rehearsed. This app's `
      + '@guren/core may predate the preflight seam (RFC 0016 §5.4).',
  }
}

/** The response body, parsed, or undefined when it was not a JSON object. */
function parseContent(outcome: ToolCallOutcome): unknown {
  const text = outcome.content[0]?.text
  if (text === undefined || text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * A list of strings, or undefined for anything else. The seam is the only
 * producer, but the value crossed an HTTP boundary to get here, and a field
 * of the advertised output schema must not be filled with whatever arrived.
 */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
