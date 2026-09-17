process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, spyOn, test } from 'bun:test'
import type { AgentPrincipal } from '@guren/core'
import { z } from 'zod'

import { Agent, MemoryConversationStore, tool } from '../src'
import { bootHarness } from './fixture'

class Support extends Agent {
  static override agentName = 'support'
  instructions = 'Help.'
}

const USER: AgentPrincipal = { kind: 'user', id: 1 }

/** The `data:` chunks of a UI-message stream body, `[DONE]` excluded. */
async function chunks(response: Response): Promise<Array<Record<string, unknown>>> {
  return (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)
}

describe('BoundAgent.stream', () => {
  test('should stream the answer as UI-message chunks, naming no conversation when none is asked for', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    h.script([{ text: 'Hello there.' }])

    const response = await h.app.container.make('ai').agent(Support).as(USER).stream('Hi')

    expect(response.headers.get('X-Guren-Conversation')).toBeNull()
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const parts = await chunks(response)
    expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.delta)).toEqual(['Hello there.'])
  })

  test('should name a new conversation in the header, store the turn once the body ends, and replay it next turn', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    const model = h.script([{ text: 'first answer' }, { text: 'second answer' }])
    const support = h.app.container.make('ai').agent(Support).as(USER)

    const first = await support.stream('first question', { conversation: true })
    const id = first.headers.get('X-Guren-Conversation')!
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await h.app.container.make('ai').conversations().load(id, USER)).toBeNull()
    await first.text()

    const second = await support.continue(id).stream('second question')
    await second.text()

    expect(second.headers.get('X-Guren-Conversation')).toBe(id)
    expect(model.doStreamCalls[1]!.prompt.slice(1).map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    const stored = await h.app.container.make('ai').conversations().load(id, USER)
    expect(stored!.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  test('should run tools while streaming and store the call with its result', async () => {
    class Lookup extends Agent {
      static override agentName = 'lookup'
      instructions = 'Look it up.'
      override tools() {
        return { order: tool({ inputSchema: z.object({ id: z.number() }), execute: async ({ id }) => ({ id, status: 'shipped' }) }) }
      }
    }
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    h.script([{ toolCalls: [{ name: 'order', input: { id: 7 } }] }, { text: 'It shipped.' }])

    const response = await h.app.container.make('ai').agent(Lookup).as(USER).stream('Where is order 7?', { conversation: true })

    const parts = await chunks(response)
    expect(parts).toContainEqual(expect.objectContaining({ type: 'tool-output-available', output: { id: 7, status: 'shipped' } }))
    const stored = await h.app.container.make('ai').conversations().load(response.headers.get('X-Guren-Conversation')!, USER)
    expect(stored!.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })

  test('should refuse a conversation under as(null) before any model call', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    const model = h.script([{ text: 'never' }])

    await expect(h.app.container.make('ai').agent(Support).as(null).stream('Hi', { conversation: true }))
      .rejects.toThrow('support was asked for a conversation under as(null).')
    expect(model.doStreamCalls).toHaveLength(0)
  })

  test('should store nothing for a turn the caller aborts mid-stream', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    const model = h.script([])
    model.doStream = async () => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({ type: 'text-start', id: 't' })
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'partial' })
          await new Promise((resolve) => setTimeout(resolve, 50))
          controller.enqueue({ type: 'text-end', id: 't' })
          controller.close()
        },
      }),
    })
    const abort = new AbortController()

    const response = await h.app.container.make('ai').agent(Support).as(USER)
      .stream('Hi', { conversation: true, signal: abort.signal })
    const reader = response.body!.getReader()
    await reader.read()
    abort.abort()
    await reader.cancel().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(await h.app.container.make('ai').conversations().load(response.headers.get('X-Guren-Conversation')!, USER)).toBeNull()
  })

  test('should finish the body and log when the turn cannot be stored', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    h.script([{ text: 'answer' }])
    const store = h.app.container.make('ai').conversations() as MemoryConversationStore
    spyOn(store, 'create').mockImplementation(async () => {
      throw new Error('store down')
    })
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await h.app.container.make('ai').agent(Support).as(USER).stream('Hi', { conversation: true })

      expect((await chunks(response)).at(-1)).toEqual({ type: 'finish', finishReason: 'stop' })
      expect(String(error.mock.calls[0]?.[0])).toContain(
        `support could not store its turn in conversation "${response.headers.get('X-Guren-Conversation')}".`,
      )
    } finally {
      error.mockRestore()
    }
  })
})
