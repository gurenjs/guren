process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, test } from 'bun:test'
import { BroadcastManager, type AgentPrincipal, type BroadcastEvent } from '@guren/core'
import { convertArrayToReadableStream } from 'ai/test'
import { z } from 'zod'

import { AGENT_CHUNK_EVENT, Agent, Output, RunAgentJob, tool } from '../src'
import { bootHarness, withQueue, type Harness } from './fixture'

class Support extends Agent {
  static override agentName = 'support'
  instructions = 'Help.'
}

class Lookup extends Agent {
  static override agentName = 'lookup'
  instructions = 'Look it up.'

  override tools() {
    return { order: tool({ description: 'Find an order', inputSchema: z.object({ id: z.number() }), execute: async ({ id }) => ({ id, status: 'shipped' }) }) }
  }
}

class Classifier extends Agent {
  static override agentName = 'classifier'
  instructions = 'Classify.'
  output = Output.object({ schema: z.object({ label: z.string() }) })
}

const USER: AgentPrincipal = { kind: 'user', id: 7 }
const CHANNEL = 'private-support.7'
const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
}

/** A first step that streams an `error` part, then a tool call the SDK still runs, then a text answer. */
function scriptRecoveredError(h: Harness): void {
  const model = h.script([{ text: 'It shipped.' }])
  const answer = model.doStream
  let call = 0
  model.doStream = async (options) => {
    if (call++ > 0) return answer(options)
    return {
      stream: convertArrayToReadableStream([
        { type: 'stream-start' as const, warnings: [] },
        { type: 'error' as const, error: new Error('transient') },
        { type: 'tool-call' as const, toolCallId: 'c1', toolName: 'order', input: JSON.stringify({ id: 4812 }) },
        { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: USAGE },
      ]),
    }
  }
}

async function bootBroadcast() {
  const h = await bootHarness({ conversations: { driver: 'memory' }, plugin: { agents: [Support, Lookup, Classifier] } })
  const broadcast = new BroadcastManager()
  h.app.container.instance('broadcast', broadcast)
  const published: BroadcastEvent[] = []
  broadcast.driver().subscribe(CHANNEL, (event) => {
    published.push(event)
  })
  const chunks = () => published.map((event) => [event.event, (event.data as { type: string }).type])
  return { h, broadcast, published, chunks, ...withQueue(h) }
}

describe('broadcast()', () => {
  test('should publish every UI-message chunk of the run to the channel, and store the turn', async () => {
    const { h, published, responded, failures, work, chunks } = await bootBroadcast()
    h.script([{ text: 'Hello there' }])

    const run = await h.app.container.make('ai').agent(Support).as(USER).broadcast('Hi', CHANNEL, { conversation: true })
    await work()

    expect(failures).toEqual([])
    expect(chunks()).toEqual([
      [AGENT_CHUNK_EVENT, 'start'],
      [AGENT_CHUNK_EVENT, 'start-step'],
      [AGENT_CHUNK_EVENT, 'text-start'],
      [AGENT_CHUNK_EVENT, 'text-delta'],
      [AGENT_CHUNK_EVENT, 'text-end'],
      [AGENT_CHUNK_EVENT, 'finish-step'],
      [AGENT_CHUNK_EVENT, 'finish'],
    ])
    expect(published[0]!.event).toBe('AgentChunk')
    expect(published.find((event) => (event.data as { type: string }).type === 'text-delta')!.data).toMatchObject({ delta: 'Hello there' })
    expect(responded).toEqual([])
    const stored = await h.app.container.make('ai').conversations().load(run.conversationId!, USER)
    expect(stored?.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  test('should publish tool input and output chunks', async () => {
    const { h, failures, work, chunks } = await bootBroadcast()
    h.script([{ toolCalls: [{ name: 'order', input: { id: 4812 } }] }, { text: 'It shipped.' }])

    await h.app.container.make('ai').agent(Lookup).as(USER).broadcast('Where is 4812?', CHANNEL)
    await work()

    expect(failures).toEqual([])
    expect(chunks().map(([, type]) => type)).toContain('tool-input-available')
    expect(chunks().map(([, type]) => type)).toContain('tool-output-available')
  })

  test('should publish one error chunk and fail the job when the run throws before streaming', async () => {
    const { h, failures, work, published } = await bootBroadcast()
    await h.app.container.make('queue').dispatch(RunAgentJob, { agentName: 'renamed', input: 'x', principal: USER, channel: CHANNEL })

    await work()

    expect(failures.map((error) => error.message)).toEqual([expect.stringContaining('No agent named "renamed"')])
    expect(published.map((event) => event.data)).toEqual([{ type: 'error', errorText: 'The agent run failed.' }])
  })

  test('should fail the job on an error chunk without publishing a second one', async () => {
    const { h, failures, work, published } = await bootBroadcast()
    const model = h.script([])
    model.doStream = async () => {
      throw new Error('provider down')
    }

    await h.app.container.make('ai').agent(Support).as(USER).broadcast('Hi', CHANNEL)
    await work()

    expect(failures).toHaveLength(1)
    const errors = published.filter((event) => (event.data as { type: string }).type === 'error')
    expect(errors).toHaveLength(1)
    expect(JSON.stringify(errors[0]!.data)).not.toContain('provider down')
  })

  test('should keep publishing after a mid-stream error chunk the SDK recovers from, then fail the job', async () => {
    const { h, failures, work, chunks } = await bootBroadcast()
    scriptRecoveredError(h)

    const run = await h.app.container.make('ai').agent(Lookup).as(USER).broadcast('Where is 4812?', CHANNEL, { conversation: true })
    await work()

    const types = chunks().map(([, type]) => type)
    expect(types).toContain('tool-output-available')
    expect(types.at(-1)).toBe('finish')
    expect(failures.map((error) => error.message)).toEqual([expect.stringContaining("lookup's broadcast run streamed an error chunk")])
    const stored = await h.app.container.make('ai').conversations().load(run.conversationId!, USER)
    expect(stored?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })

  test('should fail the job with the run\'s own error when publishing the error chunk fails too', async () => {
    const { h, broadcast, failures, work } = await bootBroadcast()
    broadcast.driver().publish = async () => {
      throw new Error('broadcast driver down')
    }
    await h.app.container.make('queue').dispatch(RunAgentJob, { agentName: 'renamed', input: 'x', principal: USER, channel: CHANNEL })

    await work()

    expect(failures.map((error) => error.message)).toEqual([expect.stringContaining('No agent named "renamed"')])
  })

  test('should not publish a second error chunk when publishing fails after the stream\'s own', async () => {
    const { h, broadcast, published, failures, work } = await bootBroadcast()
    scriptRecoveredError(h)
    const driver = broadcast.driver()
    const publish = driver.publish.bind(driver)
    // Fails the one publish after the error chunk, so a second error chunk would still get through.
    let failNext = false
    driver.publish = async (channel, event, data) => {
      if (failNext) {
        failNext = false
        throw new Error('broadcast driver down')
      }
      await publish(channel, event, data)
      failNext = (data as { type: string }).type === 'error'
    }

    await h.app.container.make('ai').agent(Lookup).as(USER).broadcast('Where is 4812?', CHANNEL)
    await work()

    expect(failures.map((error) => error.message)).toEqual(['broadcast driver down'])
    expect(published.filter((event) => (event.data as { type: string }).type === 'error')).toHaveLength(1)
  })

  // Pins the SDK closing a truncated stream with `finish`, which is why publishStream needs no guard for it.
  test('should end the channel even when the model stream closes without a finish part', async () => {
    const { h, failures, work, chunks } = await bootBroadcast()
    const model = h.script([])
    model.doStream = async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start' as const, warnings: [] },
        { type: 'text-start' as const, id: 't' },
        { type: 'text-delta' as const, id: 't', delta: 'cut off' },
      ]),
    })

    await h.app.container.make('ai').agent(Support).as(USER).broadcast('Hi', CHANNEL)
    await work()

    expect(failures).toEqual([])
    expect(chunks().at(-1)).toEqual([AGENT_CHUNK_EVENT, 'finish'])
  })

  test('should refuse an agent with an output schema, and a missing broadcast binding, before dispatching', async () => {
    const { h } = await bootBroadcast()
    await expect(h.app.container.make('ai').agent(Classifier).as(USER).broadcast('x', CHANNEL)).rejects.toThrow('declares an output schema')

    const bare = await bootHarness({ plugin: { agents: [Support] } })
    await expect(bare.app.container.make('ai').agent(Support).as(USER).broadcast('x', CHANNEL)).rejects.toThrow(
      'publishes through the `broadcast` binding',
    )
  })
})
