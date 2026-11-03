/**
 * Stored history back into `useChat` messages (RFC 0029 §4): the inverse of the AI SDK's
 * `convertToModelMessages()`, which the SDK does not ship. One turn's assistant and tool messages
 * become one assistant message with a `step-start` per model call, the shape the live stream builds.
 */
import { convertDataContentToBase64String, type ModelMessage, type UIMessage } from 'ai'

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
  toolName: string
  toolCallId: string
  input: unknown
  providerExecuted?: boolean
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
  let assistant: { parts: Array<UIPart | ToolCallState> } | undefined
  let calls = new Map<string, ToolCallState>()

  const flush = () => {
    if (assistant) out.push({ id: `${prefix}-${out.length}`, role: 'assistant', parts: assistant.parts.map(finalPart) })
    assistant = undefined
    calls = new Map()
  }

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        break
      case 'user': {
        flush()
        const content = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content
        out.push({
          id: `${prefix}-${out.length}`,
          role: 'user',
          parts: content.map((part): UIPart => {
            if (part.type === 'text') return { type: 'text', text: part.text, state: 'done' }
            if (part.type === 'image') return fileUIPart(part.image, part.mediaType ?? 'image')
            return fileUIPart(part.data, part.mediaType, part.filename)
          }),
        })
        break
      }
      case 'assistant': {
        assistant ??= { parts: [] }
        assistant.parts.push({ type: 'step-start' })
        const content = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content
        for (const part of content) {
          switch (part.type) {
            case 'text':
              assistant.parts.push({ type: 'text', text: part.text, state: 'done' })
              break
            case 'reasoning':
              assistant.parts.push({ type: 'reasoning', text: part.text, state: 'done' })
              break
            case 'custom':
              assistant.parts.push({ type: 'custom', kind: part.kind })
              break
            case 'file':
              assistant.parts.push(fileUIPart(part.data, part.mediaType, part.filename))
              break
            case 'reasoning-file': {
              const { url } = fileUIPart(part.data, part.mediaType) as Extract<UIPart, { type: 'file' }>
              assistant.parts.push({ type: 'reasoning-file', mediaType: part.mediaType, url })
              break
            }
            case 'tool-call': {
              const call: ToolCallState = {
                toolName: part.toolName,
                toolCallId: part.toolCallId,
                input: part.input,
                ...(part.providerExecuted !== undefined ? { providerExecuted: part.providerExecuted } : {}),
              }
              calls.set(part.toolCallId, call)
              assistant.parts.push(call)
              break
            }
            case 'tool-result': {
              const call = calls.get(part.toolCallId)
              if (call) call.result = part
              break
            }
            case 'tool-approval-request': {
              const call = calls.get(part.toolCallId)
              if (call) call.request = part
              break
            }
          }
        }
        break
      }
      case 'tool': {
        const approvals = new Map<string, ToolApprovalResponse>()
        for (const part of message.content) {
          if (part.type === 'tool-approval-response') approvals.set(part.approvalId, part)
        }
        for (const call of calls.values()) {
          if (call.request && approvals.has(call.request.approvalId)) call.response = approvals.get(call.request.approvalId)
        }
        for (const part of message.content) {
          if (part.type === 'tool-result') {
            const call = calls.get(part.toolCallId)
            if (call) call.result = part
          }
        }
        break
      }
    }
  }
  flush()
  return out
}

function finalPart(part: UIPart | ToolCallState): UIPart {
  if ('type' in part) return part
  const base = {
    type: `tool-${part.toolName}` as const,
    toolCallId: part.toolCallId,
    ...(part.providerExecuted !== undefined ? { providerExecuted: part.providerExecuted } : {}),
  }
  const request = part.request
    ? {
        id: part.request.approvalId,
        ...(part.request.reason !== undefined ? { requestReason: part.request.reason } : {}),
        ...(part.request.isAutomatic !== undefined ? { isAutomatic: part.request.isAutomatic } : {}),
        ...(part.request.signature !== undefined ? { signature: part.request.signature } : {}),
      }
    : undefined
  const responded = part.response
    ? { ...request!, approved: part.response.approved, ...(part.response.reason !== undefined ? { reason: part.response.reason } : {}) }
    : undefined
  const output = part.result?.output
  if (!output) {
    if (responded) return { ...base, state: 'approval-responded', input: part.input, approval: responded }
    if (request) return { ...base, state: 'approval-requested', input: part.input, approval: request }
    return { ...base, state: 'input-available', input: part.input }
  }
  const approved = responded?.approved === true ? { approval: { ...responded, approved: true as const } } : {}
  switch (output.type) {
    case 'text':
    case 'json':
    case 'content':
      return { ...base, state: 'output-available', input: part.input, output: output.value, ...approved }
    case 'error-text':
    case 'error-json': {
      // A provider's own tool error is sent unmasked live too, as `toUIMessageStream()` does.
      const shown = typeof output.value === 'string' ? output.value : JSON.stringify(output.value)
      return { ...base, state: 'output-error', input: part.input, errorText: part.providerExecuted ? shown : MASKED_ERROR_TEXT, ...approved }
    }
    case 'execution-denied':
      return {
        ...base,
        state: 'output-denied',
        input: part.input,
        approval: {
          ...(request ?? { id: part.toolCallId }),
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
function fileUIPart(data: unknown, mediaType: string, filename?: string): UIPart {
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

function isUrl(value: string): boolean {
  return /^(?:https?|data|blob):/i.test(value)
}

function dataUrl(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`
}
