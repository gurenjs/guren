/**
 * Asking the calling user about a `confirm` tool over MCP (RFC 0042 §2.3, §2.4).
 * The pipeline holds the call and hands back the question; this module owns the
 * `2026-07-28` round trip: a form elicitation in an `input_required` result, and
 * a signed `requestState` naming the tool and the fingerprint of the arguments.
 * The answer comes from the client, so it is a cooperating host's word that a
 * person saw the question. It is not authorization: that stays on `approval`.
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type InputRequiredResult,
  type ProtocolEra,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server'
import { deriveAppKey, parseAppKey, type AgentConfirmationRequest } from '@guren/core'

/** What the signed state carries. Readable by the client, which holds both values already. */
export interface ConfirmationState {
  tool: string
  fingerprint: string
}

/** The key purpose the state is signed under, apart from every other `APP_KEY` use. */
export const MCP_CONFIRMATION_KEY_PURPOSE = 'mcp-confirmation'

const CONFIRM_REQUEST = 'confirm'
/** Characters of the arguments shown in the question; a host renders the message whole. */
const ARGUMENTS_SHOWN = 1000

/**
 * The key the state is signed with, or `undefined` for an app with no valid `APP_KEY`:
 * such an app cannot ask, and refuses a `confirm` tool rather than sign with a key
 * a second instance would not hold.
 */
export function confirmationKeyFromEnv(
  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env,
): Uint8Array | undefined {
  try {
    return deriveAppKey(parseAppKey(env.APP_KEY ?? ''), MCP_CONFIRMATION_KEY_PURPOSE)
  } catch {
    return undefined
  }
}

/** What one request's codec is built from. */
export interface ConfirmationSigning {
  key: Uint8Array
  /** The caller and the endpoint: a state minted for another of either does not verify. */
  binding: string
}

export function createConfirmationCodec(signing: ConfirmationSigning): RequestStateCodec<ConfirmationState> {
  return createRequestStateCodec<ConfirmationState>({
    key: signing.key,
    bind: (ctx) => `${signing.binding}\0${ctx.mcpReq.method}`,
  })
}

/** Why this request cannot carry the question, as the refusal says it, or `undefined` when it can. */
export function cannotAsk(era: ProtocolEra, ctx: ServerContext, codec: RequestStateCodec<ConfirmationState> | undefined): string | undefined {
  if (era !== 'modern') {
    return 'This endpoint can ask only on MCP 2026-07-28, and this request used an earlier protocol version.'
  }
  // The SDK types the envelope as an empty object; the key is the one it reads itself.
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined
  if (!acceptsFormElicitation(envelope?.[CLIENT_CAPABILITIES_META_KEY])) {
    return 'The client did not declare form elicitation (capabilities.elicitation), so it cannot be asked.'
  }
  if (!codec) {
    return 'This server has no APP_KEY to sign the question with, so it cannot ask.'
  }
  return undefined
}

/** `elicitation: {}` and `elicitation: { form: {} }` both mean forms; `{ url: {} }` alone does not. */
function acceptsFormElicitation(capabilities: unknown): boolean {
  const elicitation = isRecord(capabilities) ? capabilities.elicitation : undefined
  if (!isRecord(elicitation)) return false
  return Object.keys(elicitation).length === 0 || isRecord(elicitation.form)
}

/** The `input_required` answer that asks. */
export async function askForConfirmation(
  request: AgentConfirmationRequest,
  codec: RequestStateCodec<ConfirmationState>,
  ctx: ServerContext,
): Promise<InputRequiredResult> {
  return inputRequired({
    inputRequests: {
      [CONFIRM_REQUEST]: inputRequired.elicit({
        message: describeConfirmation(request),
        requestedSchema: {
          type: 'object',
          properties: { confirm: { type: 'boolean', title: 'Run it', description: `Run "${request.tool}" with these arguments.` } },
          required: ['confirm'],
        },
      }),
    },
    requestState: await codec.mint({ tool: request.tool, fingerprint: request.fingerprint }, ctx),
  })
}

/** The message, then the redacted arguments the pipeline handed over, bounded. */
export function describeConfirmation(request: AgentConfirmationRequest): string {
  const written = JSON.stringify(request.input)
  const shown = written.length > ARGUMENTS_SHOWN ? `${written.slice(0, ARGUMENTS_SHOWN)}… (truncated)` : written
  return `${request.message}\n\nTool: ${request.tool}\nArguments: ${shown}`
}

export type ConfirmationAnswer =
  /** No answer for this tool rides on the request: the call is to be asked about. */
  | { kind: 'none' }
  /** The caller agreed to the call the verified state names. */
  | { kind: 'agreed'; fingerprint: string }
  /** The form was declined, cancelled, or returned without `confirm: true`. */
  | { kind: 'declined' }

/**
 * The answer a retried `tools/call` carries for `tool`. Read only with a codec:
 * without one the SDK passes `requestState` through unverified.
 */
export function readConfirmationAnswer(
  tool: string,
  ctx: ServerContext,
  codec: RequestStateCodec<ConfirmationState> | undefined,
): ConfirmationAnswer {
  const state: unknown = codec ? ctx.mcpReq.requestState() : undefined
  if (!isRecord(state) || state.tool !== tool || typeof state.fingerprint !== 'string') return { kind: 'none' }

  const response = inputResponse(ctx.mcpReq.inputResponses, CONFIRM_REQUEST)
  if (response.kind !== 'elicit') return { kind: 'none' }
  if (response.action !== 'accept' || response.content?.confirm !== true) return { kind: 'declined' }
  return { kind: 'agreed', fingerprint: state.fingerprint }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
