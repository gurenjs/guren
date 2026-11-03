/**
 * Stored history back into `useChat` messages (RFC 0029 §4): the inverse of the AI SDK's
 * `convertToModelMessages()`, which the SDK does not ship. One turn's assistant and tool messages
 * become one assistant message with a `step-start` per model call, the shape the live stream builds.
 */
import { convertDataContentToBase64String, type FileUIPart, type ModelMessage, type ToolCallPart, type UIMessage } from 'ai'

type UIPart = UIMessage['parts'][number]
type AssistantPart = Exclude<Extract<ModelMessage, { role: 'assistant' }>['content'], string>[number]
type ToolMessagePart = Extract<ModelMessage, { role: 'tool' }>['content'][number]
type ToolResult = Extract<AssistantPart, { type: 'tool-result' }>
type ToolApprovalRequest = Extract<AssistantPart, { type: 'tool-approval-request' }>
type ToolApprovalResponse = Extract<ToolMessagePart, { type: 'tool-approval-response' }>

/**
 * What `stream()` sends in place of an error, the SDK's own default. The store keeps the exception's
 * message for the model, so a restored tool error must be masked to the same text.
 */
export const MASKED_ERROR_TEXT = 'An error occurred.'

export interface ToUIMessagesOptions {
  /** Each message's id is `<idPrefix>-<n>`, so the same history renders under the same keys. Default `message`. */
  idPrefix?: string
}

interface ToolCallState {
  call: ToolCallPart
  request?: ToolApprovalRequest
  response?: ToolApprovalResponse
  result?: ToolResult
}

/**
 * The messages `useChat({ messages })` starts from, for a history read from a conversation store.
 * Tools become `tool-<name>` parts in their final state (a `dynamicTool()` too), an application tool's
 * error is masked as live, a `toModelOutput` result shows what the model saw, and a system message is
 * dropped. Provider metadata is not carried: the next turn replays the stored history, never these.
 */
export function toUIMessages(messages: readonly ModelMessage[], options: ToUIMessagesOptions = {}): UIMessage[] {
  const prefix = options.idPrefix ?? 'message'
  const out: UIMessage[] = []
  let parts: Array<UIPart | ToolCallState> | undefined
  // One turn's calls, by tool call id and by approval id: a result or a response may come in a later message.
  const calls = new Map<string, ToolCallState>()
  const approvals = new Map<string, ToolCallState>()

  const flush = () => {
    if (!parts) return
    out.push({ id: `${prefix}-${out.length}`, role: 'assistant', parts: parts.map(finalPart) })
    parts = undefined
    calls.clear()
    approvals.clear()
  }

  const track = (part: ToolResult | ToolApprovalRequest | ToolApprovalResponse) => {
    if (part.type === 'tool-approval-response') {
      const call = approvals.get(part.approvalId)
      if (call) call.response = part
      return
    }
    const call = calls.get(part.toolCallId)
    if (!call) return
    if (part.type === 'tool-result') call.result = part
    else {
      call.request = part
      approvals.set(part.approvalId, call)
    }
  }

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        break
      case 'user': {
        flush()
        out.push({
          id: `${prefix}-${out.length}`,
          role: 'user',
          parts: textOrParts(message.content).map((part): UIPart => {
            if (part.type === 'text') return { type: 'text', text: part.text, state: 'done' }
            if (part.type === 'image') return fileUIPart(part.image, part.mediaType ?? 'image')
            return fileUIPart(part.data, part.mediaType, part.filename)
          }),
        })
        break
      }
      case 'assistant': {
        parts ??= []
        parts.push({ type: 'step-start' })
        for (const part of textOrParts(message.content)) {
          switch (part.type) {
            case 'text':
              parts.push({ type: 'text', text: part.text, state: 'done' })
              break
            case 'reasoning':
              parts.push({ type: 'reasoning', text: part.text, state: 'done' })
              break
            case 'custom':
              parts.push({ type: 'custom', kind: part.kind })
              break
            case 'file':
              parts.push(fileUIPart(part.data, part.mediaType, part.filename))
              break
            case 'reasoning-file':
              parts.push({ type: 'reasoning-file', mediaType: part.mediaType, url: fileUIPart(part.data, part.mediaType).url })
              break
            case 'tool-call': {
              const call: ToolCallState = { call: part }
              calls.set(part.toolCallId, call)
              parts.push(call)
              break
            }
            default:
              track(part)
          }
        }
        break
      }
      case 'tool':
        for (const part of message.content) track(part)
        break
    }
  }
  flush()
  return out
}

function textOrParts<P>(content: string | P[]): Array<P | { type: 'text'; text: string }> {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

function finalPart(part: UIPart | ToolCallState): UIPart {
  if ('type' in part) return part
  const { call } = part
  const input = call.input
  const base = {
    type: `tool-${call.toolName}` as const,
    toolCallId: call.toolCallId,
    ...(call.providerExecuted !== undefined ? { providerExecuted: call.providerExecuted } : {}),
  }
  const request = part.request
    ? {
        id: part.request.approvalId,
        ...(part.request.reason !== undefined ? { requestReason: part.request.reason } : {}),
        ...(part.request.isAutomatic !== undefined ? { isAutomatic: part.request.isAutomatic } : {}),
        ...(part.request.signature !== undefined ? { signature: part.request.signature } : {}),
      }
    : undefined
  const responded = request && part.response
    ? { ...request, approved: part.response.approved, ...(part.response.reason !== undefined ? { reason: part.response.reason } : {}) }
    : undefined
  const output = part.result?.output
  if (!output) {
    if (responded) return { ...base, state: 'approval-responded', input, approval: responded }
    if (request) return { ...base, state: 'approval-requested', input, approval: request }
    return { ...base, state: 'input-available', input }
  }
  const approved = responded?.approved === true ? { approval: { ...responded, approved: true as const } } : {}
  switch (output.type) {
    case 'text':
    case 'json':
    case 'content':
      return { ...base, state: 'output-available', input, output: output.value, ...approved }
    case 'error-text':
    case 'error-json': {
      // A provider's own tool error is sent unmasked live too, as `toUIMessageStream()` does.
      const shown = typeof output.value === 'string' ? output.value : JSON.stringify(output.value)
      return { ...base, state: 'output-error', input, errorText: call.providerExecuted ? shown : MASKED_ERROR_TEXT, ...approved }
    }
    case 'execution-denied':
      return {
        ...base,
        state: 'output-denied',
        input,
        approval: {
          ...(request ?? { id: call.toolCallId }),
          approved: false,
          ...(output.reason !== undefined ? { reason: output.reason } : {}),
        },
      }
  }
}

/**
 * A stored file's data is a base64 string or a URL's href after `storableMessages()`, a tagged
 * `FileData` as written, or a provider reference, which has no URL to show.
 */
function fileUIPart(data: unknown, mediaType: string, filename?: string): FileUIPart {
  const named = filename !== undefined ? { filename } : {}
  const url = (value: string) => ({ type: 'file' as const, mediaType, url: value, ...named })
  if (data instanceof URL) return url(data.href)
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) return url(dataUrl(mediaType, convertDataContentToBase64String(data)))
  if (typeof data === 'string') return url(isUrl(data) ? data : dataUrl(mediaType, data))
  if (data !== null && typeof data === 'object') {
    const tagged = data as { type?: unknown; data?: unknown; url?: unknown; text?: unknown; reference?: unknown }
    if (tagged.type === 'data') return fileUIPart(tagged.data, mediaType, filename)
    if (tagged.type === 'url') return fileUIPart(tagged.url instanceof URL ? tagged.url : String(tagged.url), mediaType, filename)
    if (tagged.type === 'text' && typeof tagged.text === 'string') {
      return url(dataUrl(mediaType, convertDataContentToBase64String(new TextEncoder().encode(tagged.text))))
    }
    const reference = (tagged.type === 'reference' ? tagged.reference : data) as Record<string, string>
    return { type: 'file', mediaType, url: '', providerReference: reference, ...named }
  }
  return url('')
}

/** Any scheme: base64 never holds a colon, and `storable()` stores every `URL` as its href. */
function isUrl(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(value)
}

function dataUrl(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`
}
