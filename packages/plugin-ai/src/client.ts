/**
 * `@guren/plugin-ai/client`: the browser half of `stream()` (RFC 0029 §4). Imports only `ai` and the
 * protocol constant, so a page bundle pulls in no server module.
 */
import { DefaultChatTransport, type ChatTransport, type HttpChatTransportInitOptions, type UIMessage, type UIMessageChunk } from 'ai'

import type { ChatTurn } from './chat'
import { CONVERSATION_HEADER } from './protocol'

export { AGENT_CHUNK_EVENT } from './protocol'
export type { UIMessage } from 'ai'

// `XSRF_COOKIE_NAME` and `XSRF_HEADER_NAME` in @guren/server's CSRF middleware, which this entry cannot import;
// `readXsrfToken()` in @guren/plugin-webmcp's client reads the same cookie.
const XSRF_COOKIE = 'XSRF-TOKEN'
const XSRF_HEADER = 'X-XSRF-TOKEN'

export interface ChatTransportOptions {
  /** The conversation to continue, from the page props; absent, the first turn starts one. */
  conversation?: string | null
  /**
   * Called when the transport adopts a conversation the server named, e.g. to update the URL: once the
   * turn's body has finished, since a turn stopped or failed before its answer stores no conversation.
   */
  onConversation?: (id: string) => void
  headers?: Record<string, string>
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

/**
 * A `useChat` transport posting `{ conversation, message }` to a route that calls `stream()`: the last
 * user message as text, never the transcript, since history the client sends is input it controls.
 */
export function createChatTransport<M extends UIMessage = UIMessage>(
  api: string,
  options: ChatTransportOptions = {},
): ChatTransport<M> {
  let conversation = options.conversation ?? null
  const named = new WeakMap<object, string>()
  return new ConversationTransport<M>(named, (id) => {
    if (id === conversation) return
    conversation = id
    options.onConversation?.(id)
  }, {
    api,
    credentials: 'same-origin',
    headers: () => ({ ...options.headers, ...xsrfHeader() }),
    // Bun's `typeof fetch` carries `preconnect`, which a wrapper has no reason to implement.
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await (options.fetch ?? globalThis.fetch)(input, init)
      const id = response.headers.get(CONVERSATION_HEADER)
      // Keyed by the body the transport parses next, so each turn's id stays with its own response.
      if (id && response.body) named.set(response.body, id)
      return response
    }) as typeof globalThis.fetch,
    prepareSendMessagesRequest: ({ messages, trigger }) => {
      if (trigger === 'regenerate-message') {
        throw new Error('createChatTransport() cannot regenerate a message: the server keeps the history, and it has no turn to replace.')
      }
      const body: ChatTurn = { conversation, message: lastUserText(messages) }
      return { body }
    },
  })
}

class ConversationTransport<M extends UIMessage> extends DefaultChatTransport<M> {
  constructor(
    private readonly named: WeakMap<object, string>,
    private readonly adopt: (id: string) => void,
    init: HttpChatTransportInitOptions<M>,
  ) {
    super(init)
  }

  protected override processResponseStream(stream: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
    const chunks = super.processResponseStream(stream)
    const id = this.named.get(stream)
    return id === undefined ? chunks : chunks.pipeThrough(adoptOnFinish(() => this.adopt(id)))
  }
}

/**
 * Adopts the id only for a body read to its end after a `finish` chunk with no `error` or `abort`. The
 * server stores a turn once the model answers (`onEnd`), and nothing for one aborted or failing before
 * a step: adopting that id would fail every later turn. An `error` chunk is never adopted, since
 * `useChat` stops reading at it, which cancels the body the server would store the turn at the end of.
 * `flush` runs before the reader sees `done`, so `onConversation` precedes `useChat`'s `onFinish`.
 */
function adoptOnFinish(adopt: () => void): TransformStream<UIMessageChunk, UIMessageChunk> {
  let finished = false
  let failed = false
  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.type === 'finish') finished = true
      else if (chunk.type === 'error' || chunk.type === 'abort') failed = true
      controller.enqueue(chunk)
    },
    flush() {
      if (finished && !failed) adopt()
    },
  })
}

function lastUserText(messages: readonly UIMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === 'user')
  if (last?.parts.some((part) => part.type === 'file')) {
    throw new Error('createChatTransport() sends the user message as text, and this one attaches a file it would drop.')
  }
  const text = last?.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('') ?? ''
  if (!text) throw new Error('createChatTransport() sends the last user message as text, and there is none to send.')
  return text
}

function xsrfHeader(): Record<string, string> {
  const cookies = (globalThis as { document?: { cookie?: string } }).document?.cookie
  for (const part of cookies?.split(';') ?? []) {
    const entry = part.trim()
    if (!entry.startsWith(`${XSRF_COOKIE}=`)) continue
    const value = entry.slice(XSRF_COOKIE.length + 1)
    try {
      return { [XSRF_HEADER]: decodeURIComponent(value) }
    } catch {
      return { [XSRF_HEADER]: value }
    }
  }
  return {}
}
