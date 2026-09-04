/**
 * `guren.preflight` — the preflight companion tool (RFC 0016 §5.4).
 *
 * Preflight cannot be an argument of the tool being checked: MCP forbids a tool
 * from returning a different *shape* of success (the SDK client throws `-32600`
 * for a schema-declaring tool that returns plain content), so the verdict gets a
 * tool of its own — one for the whole catalogue, since per-tool companions would
 * double a catalogue §5.5 already wants small. This module owns only the
 * advertised schemas and the translation of the seam's answer into a verdict.
 */
import { PREFLIGHT_TOOL_NAME, type ToolCallOutcome } from '@guren/core'

/** A JSON Schema object as MCP advertises it. */
type McpObjectSchema = { type: 'object'; [key: string]: unknown }

/**
 * `input` is an open object because it stands in for *another tool's* input
 * schema, and is not validated here: it is handed to the route, whose own
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
 * `validated` and `unverified` are not required: a call refused by middleware in
 * front of the seam never reaches it, and `[]` would claim checks that were
 * never reached. `additionalProperties` is deliberately unset — the SDK client
 * validates `structuredContent` against this schema, and a closed object would
 * turn any later field into a `-32602` for clients pinned to an older server.
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
 * The tool as `tools/list` advertises it. The description says that it executes
 * nothing: an agent decides from that line alone whether asking is safe.
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
 * Read `{ tool, input }` off a raw call. The low-level `Server` hands arguments
 * through unvalidated, and these are the one place on this surface where an
 * unchecked value decides *which* tool is addressed.
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
 * Read the dispatched response as a verdict. The seam is mounted last before the
 * handler and answers unconditionally, which settles the three branches: the
 * `preflightVerdict` marker (set from the response header, never re-read from
 * the body) means allowed and unrun; a 4xx/5xx can only come from a gate in
 * front of the seam or the seam's own validation, so nothing ran and it is
 * `allowed: false`; anything else means a handler ran, reported as an error
 * rather than a rehearsal — a redirect from a controller that just created a
 * record must not be described as a call that did not happen.
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
    // The application's own error body as the exception handler wrote it:
    // `{ message, errors? }` for an `HttpException`. Anything else still has
    // text, and that text is the message.
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
 * A list of strings, or undefined for anything else: the value crossed an HTTP
 * boundary, and a field of the advertised output schema must not be filled with
 * whatever arrived.
 */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
