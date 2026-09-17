/**
 * `@guren/plugin-ai/client`: the browser half of `stream()` (RFC 0029 §4). Imports only `ai` and the
 * protocol constant, so a page bundle pulls in no server module.
 */
import { DefaultChatTransport, type ChatTransport, type UIMessage } from 'ai'

import type { ChatTurn } from './chat'
import { CONVERSATION_HEADER } from './protocol'

// `XSRF_COOKIE_NAME` and `XSRF_HEADER_NAME` in @guren/server's CSRF middleware, which this entry cannot import.
const XSRF_COOKIE = 'XSRF-TOKEN'
const XSRF_HEADER = 'X-XSRF-TOKEN'

export interface ChatTransportOptions {
  /** The conversation to continue, from the page props; absent, the first turn starts one. */
  conversation?: string | null
  /** Called when the server names a conversation the transport did not hold, e.g. to update the URL. */
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
  return new DefaultChatTransport<M>({
    api,
    credentials: 'same-origin',
    headers: () => ({ ...options.headers, ...xsrfHeader() }),
    // Bun's `typeof fetch` carries `preconnect`, which a wrapper has no reason to implement.
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await (options.fetch ?? globalThis.fetch)(input, init)
      const named = response.headers.get(CONVERSATION_HEADER)
      if (named && named !== conversation) {
        conversation = named
        options.onConversation?.(named)
      }
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

function lastUserText(messages: readonly UIMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === 'user')
  const text = last?.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('') ?? ''
  if (!text) throw new Error('createChatTransport() sends the last user message as text, and there is none to send.')
  return text
}

function xsrfHeader(): Record<string, string> {
  if (typeof document === 'undefined') return {}
  const cookie = document.cookie.split('; ').find((entry) => entry.startsWith(`${XSRF_COOKIE}=`))
  return cookie ? { [XSRF_HEADER]: decodeURIComponent(cookie.slice(XSRF_COOKIE.length + 1)) } : {}
}
