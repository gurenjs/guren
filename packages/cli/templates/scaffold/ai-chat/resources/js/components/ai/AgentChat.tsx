// Written by `guren make:ai-agent --chat`, then the app's own: edit it freely.
import { useChat } from '@ai-sdk/react'
import { router } from '@inertiajs/react'
import { createChatTransport, type UIMessage } from '@guren/plugin-ai/client'
import { memo, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Alert } from '@/resources/js/components/ui/Alert'
import { Button } from '@/resources/js/components/ui/Button'
import { Textarea } from '@/resources/js/components/ui/Textarea'

type Part = UIMessage['parts'][number]
type ToolPart = Extract<Part, { toolCallId: string }>

export interface AgentChatProps {
  /** The route whose action returns `stream()`. */
  api: string
  conversationId: string | null
  /** The stored history, from `history(id)` in the page action. */
  messages: UIMessage[]
  placeholder?: string
}

/**
 * Keyed by the conversation, since the transport keeps the id it was created with. A conversation this
 * mount started keeps the mount when the page props catch up.
 */
export function AgentChat(props: AgentChatProps) {
  const adopted = useRef<string | null>(null)
  const fresh = props.conversationId === null || props.conversationId === adopted.current
  return (
    <Conversation
      key={fresh ? 'new' : props.conversationId}
      {...props}
      onAdopted={(id) => {
        adopted.current = id
      }}
    />
  )
}

interface ConversationProps extends AgentChatProps {
  onAdopted: (id: string) => void
}

function Conversation({ api, conversationId, messages: initialMessages, placeholder = 'Ask a question', onAdopted }: ConversationProps) {
  const started = useRef<string | null>(null)
  const [chatId] = useState(() => conversationId ?? undefined)
  const [transport] = useState(() =>
    createChatTransport(api, {
      conversation: conversationId,
      onConversation: (id) => {
        started.current = id
      },
    }))
  const { messages, sendMessage, status, stop, error, clearError } = useChat({
    id: chatId,
    messages: initialMessages,
    transport,
    // At most one render per 50 ms while the answer streams, rather than one per token.
    throttle: 50,
    onFinish: ({ messages: shown, isAbort, isError }) => {
      // A first turn stopped or failed stores nothing, and the transport adopts no id for it.
      const id = conversationId ?? started.current
      if (isAbort || isError || id === null) return
      // Only a mount that started the conversation; one that opened it is already keyed by its id.
      if (chatId === undefined) onAdopted(id)
      // Without a request: the history entry Back restores then carries the id and every turn shown.
      const url = new URL(window.location.href)
      url.searchParams.set('conversation', id)
      router.replace({
        url: url.pathname + url.search,
        props: (current) => ({ ...current, conversationId: id, messages: shown }),
        preserveState: true,
        preserveScroll: true,
      })
    },
  })
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const busy = status === 'submitted' || status === 'streaming'

  // On a new message and when the answer ends, not per token, so a reader scrolled up is left there.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, status])

  const send = (event?: FormEvent) => {
    event?.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    clearError()
    void sendMessage({ text })
    setDraft('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // An Enter that confirms an IME conversion must not send; Safari reports it only as keyCode 229.
    const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
    if (event.key === 'Enter' && !event.shiftKey && !composing) send(event)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-4">
        {messages.length === 0 ? <p className="text-sm text-g-muted">No messages yet.</p> : null}
        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        {status === 'submitted' ? <p className="font-mono text-xs text-g-muted">Thinking…</p> : null}
        <div ref={end} />
      </div>
      <p role="status" className="sr-only">{busy ? 'The agent is answering.' : ''}</p>
      {error ? <Alert tone="danger">The agent could not answer. Try again.</Alert> : null}
      {/* method and action: a submit before hydration posts to the chat route, never a GET with the text in the URL. */}
      <form method="post" action={api} onSubmit={send} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Textarea
          aria-label="Message"
          rows={2}
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="flex justify-end gap-2">
          <Button type="submit" disabled={busy || !draft.trim()}>Send</Button>
          <Button variant="secondary" disabled={!busy} onClick={() => void stop()}>Stop</Button>
        </div>
      </form>
    </div>
  )
}

// Memoized: a streamed update keeps every earlier message's identity, so only the last one renders.
const Message = memo(function Message({ message }: { message: UIMessage }) {
  const user = message.role === 'user'
  return (
    <article className={user ? 'ml-auto max-w-[85%]' : 'max-w-[85%]'}>
      <p className={`mb-1 font-mono text-xs text-g-muted${user ? ' text-right' : ''}`}>{user ? 'You' : 'Agent'}</p>
      <div className={`space-y-2 rounded-g-card px-4 py-3 text-g-text ${user ? 'bg-g-accent-tint' : 'border border-g-line bg-g-panel'}`}>
        {message.parts.map((part, index) => (
          <MessagePart key={index} part={part} />
        ))}
      </div>
    </article>
  )
})

function MessagePart({ part }: { part: Part }) {
  if (part.type === 'text') return <p className="whitespace-pre-wrap">{part.text}</p>
  if (part.type === 'reasoning') {
    return (
      <details className="text-sm text-g-text-2">
        <summary className="cursor-pointer font-mono text-xs text-g-muted">Reasoning</summary>
        <p className="mt-1 whitespace-pre-wrap">{part.text}</p>
      </details>
    )
  }
  if (part.type === 'file') {
    const label = part.filename ?? part.mediaType
    // An empty url is a provider's reference to a file it holds, with nothing here to open.
    if (!part.url) return <span className="text-sm text-g-muted">{label}</span>
    return (
      <a href={part.url} className="text-sm text-g-accent-text underline">
        {label}
      </a>
    )
  }
  if ('toolCallId' in part) return <ToolCall part={part} />
  return null
}

const TOOL_STATES: Record<ToolPart['state'], { label: string; tone: string }> = {
  'input-streaming': { label: 'running', tone: 'text-g-muted' },
  'input-available': { label: 'running', tone: 'text-g-muted' },
  'approval-requested': { label: 'awaiting approval', tone: 'text-g-warn' },
  'approval-responded': { label: 'running', tone: 'text-g-muted' },
  'output-available': { label: 'done', tone: 'text-g-ok' },
  'output-error': { label: 'failed', tone: 'text-g-danger' },
  'output-denied': { label: 'denied', tone: 'text-g-danger' },
}

function ToolCall({ part }: { part: ToolPart }) {
  const name = part.type === 'dynamic-tool' ? part.toolName : part.type.slice('tool-'.length)
  const state = TOOL_STATES[part.state]
  return (
    <details className="rounded-g-ctl border border-g-line px-3 py-2 text-sm">
      <summary className="cursor-pointer font-mono text-xs">
        <span className="text-g-heading">{name}</span> <span className={state.tone}>{state.label}</span>
      </summary>
      <dl className="mt-2 space-y-2 font-mono text-xs text-g-text-2">
        <ToolField label="Input">{json(part.input)}</ToolField>
        {part.state === 'output-available' ? <ToolField label="Output">{json(part.output)}</ToolField> : null}
        {part.state === 'output-error' ? <ToolField label="Error" tone="text-g-danger">{part.errorText}</ToolField> : null}
      </dl>
    </details>
  )
}

function ToolField({ label, tone = '', children }: { label: string; tone?: string; children: string }) {
  return (
    <div>
      <dt className="text-g-muted">{label}</dt>
      <dd className={`mt-0.5 overflow-x-auto whitespace-pre-wrap ${tone}`}>{children}</dd>
    </div>
  )
}

function json(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value, null, 2)
}
