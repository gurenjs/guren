// Written by `guren make:ai-agent --chat`, then the app's own: edit it freely.
import { useChat } from '@ai-sdk/react'
import { router } from '@inertiajs/react'
import { createChatTransport, type UIMessage } from '@guren/plugin-ai/client'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
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
 * mount started keeps the mount when the page props catch up, and `restart` remounts a first turn that
 * stored nothing, keeping what it showed, so the next message starts afresh.
 */
export function AgentChat(props: AgentChatProps) {
  const adopted = useRef<string | null>(null)
  const [restart, setRestart] = useState({ count: 0, messages: [] as UIMessage[], failed: false })
  const fresh = props.conversationId === null || props.conversationId === adopted.current
  return (
    <Conversation
      key={`${fresh ? 'new' : props.conversationId}:${restart.count}`}
      {...props}
      messages={restart.count > 0 && props.conversationId === null ? restart.messages : props.messages}
      failed={restart.failed && props.conversationId === null}
      onAdopted={(id) => {
        adopted.current = id
      }}
      onRestart={(messages, failed) => {
        adopted.current = null
        setRestart(({ count }) => ({ count: count + 1, messages, failed }))
      }}
    />
  )
}

interface ConversationProps extends AgentChatProps {
  failed: boolean
  onAdopted: (id: string) => void
  onRestart: (messages: UIMessage[], failed: boolean) => void
}

function Conversation({
  api,
  conversationId,
  messages: initialMessages,
  placeholder = 'Ask a question',
  failed: failedBefore,
  onAdopted,
  onRestart,
}: ConversationProps) {
  const started = useRef<string | null>(null)
  const stored = useRef(conversationId !== null)
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
    onFinish: ({ messages: shown, isAbort, isError }) => {
      const id = conversationId ?? started.current
      if (isAbort || isError) {
        // The transport took the id from the response headers, and a first turn stores nothing until it answers.
        if (!stored.current && started.current !== null) onRestart(shown, !isAbort)
        return
      }
      if (id === null) return
      stored.current = true
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
  const [failed, setFailed] = useState(failedBefore)
  const end = useRef<HTMLDivElement>(null)
  const busy = status === 'submitted' || status === 'streaming'

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const send = (event?: FormEvent) => {
    event?.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    clearError()
    setFailed(false)
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
      {error || failed ? <Alert tone="danger">The agent could not answer. Try again.</Alert> : null}
      {/* method and action: a submit before hydration posts to the chat route, never a GET with the text in the URL. */}
      <form method="post" action={api} onSubmit={send} className="flex items-end gap-2">
        <Textarea
          aria-label="Message"
          rows={2}
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button type="submit" disabled={busy || !draft.trim()}>Send</Button>
        <Button variant="secondary" disabled={!busy} onClick={() => void stop()}>Stop</Button>
      </form>
    </div>
  )
}

function Message({ message }: { message: UIMessage }) {
  const user = message.role === 'user'
  return (
    <article className={user ? 'ml-auto max-w-[85%]' : 'max-w-[85%]'}>
      <p className={user ? 'mb-1 text-right font-mono text-xs text-g-muted' : 'mb-1 font-mono text-xs text-g-muted'}>
        {user ? 'You' : 'Agent'}
      </p>
      <div
        className={
          user
            ? 'space-y-2 rounded-g-card bg-g-accent-tint px-4 py-3 text-g-text'
            : 'space-y-2 rounded-g-card border border-g-line bg-g-panel px-4 py-3 text-g-text'
        }
      >
        {message.parts.map((part, index) => (
          <MessagePart key={index} part={part} />
        ))}
      </div>
    </article>
  )
}

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
    return (
      <a href={part.url} className="text-sm text-g-accent-text underline">
        {part.filename ?? part.mediaType}
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
      <div className="mt-2 space-y-2 font-mono text-xs text-g-text-2">
        <pre className="overflow-x-auto whitespace-pre-wrap">{json(part.input)}</pre>
        {part.state === 'output-available' ? <pre className="overflow-x-auto whitespace-pre-wrap">{json(part.output)}</pre> : null}
        {part.state === 'output-error' ? <p className="text-g-danger">{part.errorText}</p> : null}
      </div>
    </details>
  )
}

function json(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value, null, 2)
}
