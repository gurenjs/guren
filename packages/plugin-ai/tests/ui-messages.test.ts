process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, test } from 'bun:test'
import type { AgentPrincipal } from '@guren/core'
import { convertToModelMessages, readUIMessageStream, validateUIMessages, type ModelMessage, type UIMessage, type UIMessageChunk } from 'ai'
import { z } from 'zod'

import { Agent, toUIMessages, tool } from '../src'
import { bootHarness } from './fixture'

class Support extends Agent {
  static override agentName = 'support'
  instructions = 'Help.'
}

class Billing extends Agent {
  static override agentName = 'billing'
  instructions = 'Bill.'
}

class Lookup extends Agent {
  static override agentName = 'lookup'
  instructions = 'Look it up.'
  override tools() {
    return { order: tool({ inputSchema: z.object({ id: z.number() }), execute: async ({ id }) => ({ id, status: 'shipped' }) }) }
  }
}

const USER: AgentPrincipal = { kind: 'user', id: 1 }
const OTHER: AgentPrincipal = { kind: 'user', id: 2 }

/** The assistant message `useChat` builds from a stream body. */
async function liveMessage(response: Response): Promise<UIMessage> {
  const chunks = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice('data: '.length)) as UIMessageChunk)
  let last: UIMessage | undefined
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  for await (const message of readUIMessageStream({ stream })) last = message
  return last!
}

/** What a reader of a part renders: ids, streaming state and provider metadata left out. */
function rendered(parts: UIMessage['parts']): unknown[] {
  return parts.map((part) => {
    const { state, providerMetadata, callProviderMetadata, resultProviderMetadata, ...rest } = part as Record<string, unknown>
    void providerMetadata
    void callProviderMetadata
    void resultProviderMetadata
    return part.type.startsWith('tool-') ? { ...rest, state } : rest
  })
}

describe('toUIMessages', () => {
  test('should render a stored tool turn as the stream rendered it live', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    h.script([{ toolCalls: [{ name: 'order', input: { id: 7 } }] }, { text: 'It shipped.' }])

    const response = await h.app.container.make('ai').agent(Lookup).as(USER).stream('Where is order 7?', { conversation: true })
    const live = await liveMessage(response)
    const id = response.headers.get('X-Guren-Conversation')!
    const restored = await h.app.container.make('ai').agent(Lookup).as(USER).history(id)

    expect(restored!.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(restored![0]!.parts).toEqual([{ type: 'text', text: 'Where is order 7?', state: 'done' }])
    expect(rendered(restored![1]!.parts)).toEqual(rendered(live.parts))
    expect(restored![1]!.parts).toContainEqual(expect.objectContaining({
      type: 'tool-order',
      state: 'output-available',
      input: { id: 7 },
      output: { id: 7, status: 'shipped' },
    }))
  })

  test('should mask a failed tool on reload as the live stream masked it, keeping the message for the model', async () => {
    class Failing extends Agent {
      static override agentName = 'failing'
      instructions = 'Try it.'
      override tools() {
        return {
          refund: tool({
            inputSchema: z.object({ id: z.number() }),
            execute: async (): Promise<{ refunded: boolean }> => {
              throw new Error('connection to db-internal:5432 refused')
            },
          }),
        }
      }
    }
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    h.script([{ toolCalls: [{ name: 'refund', input: { id: 7 } }] }, { text: 'The refund failed.' }])

    const response = await h.app.container.make('ai').agent(Failing).as(USER).stream('Refund 7', { conversation: true })
    const live = await liveMessage(response)
    const id = response.headers.get('X-Guren-Conversation')!
    const restored = await h.app.container.make('ai').agent(Failing).as(USER).history(id)
    const stored = await h.app.container.make('ai').conversations().load(id, USER)

    expect(rendered(restored![1]!.parts)).toEqual(rendered(live.parts))
    expect(JSON.stringify(restored)).not.toContain('db-internal')
    expect(JSON.stringify(stored!.messages)).toContain('db-internal')
  })

  test('should give each message an id from the conversation, the same on every read', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    h.script([{ text: 'first' }, { text: 'second' }])
    const support = h.app.container.make('ai').agent(Support).as(USER)

    const { conversationId } = await support.prompt('one', { conversation: true })
    await support.continue(conversationId!).prompt('two')
    const ids = (await support.history(conversationId!))!.map((message) => message.id)

    expect(ids).toEqual([0, 1, 2, 3].map((n) => `${conversationId}-${n}`))
    expect((await support.history(conversationId!))!.map((message) => message.id)).toEqual(ids)
  })

  test('should answer another principal, another agent and an unknown id with null alike', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    h.script([{ text: 'mine' }])
    const ai = h.app.container.make('ai')
    const { conversationId } = await ai.agent(Support).as(USER).prompt('Hi', { conversation: true })

    expect(await ai.agent(Support).as(OTHER).history(conversationId!)).toBeNull()
    expect(await ai.agent(Billing).as(USER).history(conversationId!)).toBeNull()
    expect(await ai.agent(Support).as(USER).history('missing')).toBeNull()
  })

  test('should refuse to read history under as(null)', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })

    await expect(h.app.container.make('ai').agent(Support).as(null).history('any'))
      .rejects.toThrow('support was asked for a conversation under as(null).')
  })

  test('should turn tool errors, denials and pending approvals into their final part states', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'a', toolName: 'refund', input: { id: 1 } },
          { type: 'tool-call', toolCallId: 'b', toolName: 'refund', input: { id: 2 } },
          { type: 'tool-call', toolCallId: 'c', toolName: 'refund', input: { id: 3 } },
          { type: 'tool-approval-request', approvalId: 'ap-c', toolCallId: 'c' },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'a', toolName: 'refund', output: { type: 'error-text', value: 'Refund failed.' } },
          { type: 'tool-result', toolCallId: 'b', toolName: 'refund', output: { type: 'execution-denied', reason: 'Not allowed.' } },
        ],
      },
    ]

    const [, assistant] = toUIMessages(messages)

    expect(assistant!.parts).toEqual([
      { type: 'step-start' },
      { type: 'tool-refund', toolCallId: 'a', state: 'output-error', input: { id: 1 }, errorText: 'An error occurred.' },
      { type: 'tool-refund', toolCallId: 'b', state: 'output-denied', input: { id: 2 }, approval: { id: 'b', approved: false, reason: 'Not allowed.' } },
      { type: 'tool-refund', toolCallId: 'c', state: 'approval-requested', input: { id: 3 }, approval: { id: 'ap-c' } },
    ])
  })

  test('should keep a turn of several steps in one assistant message, with a step-start per model call', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Look up 7' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'Need the order.' }, { type: 'tool-call', toolCallId: 'x', toolName: 'order', input: { id: 7 } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'x', toolName: 'order', output: { type: 'json', value: { status: 'shipped' } } }] },
      { role: 'assistant', content: 'It shipped.' },
      { role: 'user', content: 'Thanks' },
      { role: 'assistant', content: [{ type: 'text', text: 'Welcome.' }] },
    ]

    const restored = toUIMessages(messages, { idPrefix: 'c1' })

    expect(restored.map((message) => [message.id, message.role])).toEqual([
      ['c1-0', 'user'], ['c1-1', 'assistant'], ['c1-2', 'user'], ['c1-3', 'assistant'],
    ])
    expect(restored[1]!.parts.map((part) => part.type)).toEqual(['step-start', 'reasoning', 'tool-order', 'step-start', 'text'])
    expect(await validateUIMessages({ messages: restored })).toHaveLength(4)
    expect(await convertToModelMessages(restored)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Look up 7' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Need the order.', providerOptions: undefined },
          { type: 'tool-call', toolCallId: 'x', toolName: 'order', input: { id: 7 }, providerExecuted: undefined },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'x', toolName: 'order', output: { type: 'json', value: { status: 'shipped' } } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'It shipped.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Thanks' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Welcome.' }] },
    ])
  })

  test('should show a stored file as a data URL, and a URL as itself', () => {
    const [user] = toUIMessages([
      {
        role: 'user',
        content: [
          { type: 'file', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
          { type: 'file', mediaType: 'application/pdf', filename: 'a.pdf', data: 'https://example.com/a.pdf' },
        ],
      },
    ])

    expect(user!.parts).toEqual([
      { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' },
      { type: 'file', mediaType: 'application/pdf', url: 'https://example.com/a.pdf', filename: 'a.pdf' },
    ])
  })
})
