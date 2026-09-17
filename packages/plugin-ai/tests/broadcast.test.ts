process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, test } from 'bun:test'
import {
  BroadcastManager,
  MemoryQueueDriver,
  Worker,
  createQueueManager,
  type AgentPrincipal,
  type BroadcastEvent,
  type EventManager,
} from '@guren/core'
import { z } from 'zod'

import { AGENT_CHUNK_EVENT, Agent, AgentResponded, Output, RunAgentJob, tool } from '../src'
import { bootHarness } from './fixture'

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

async function bootBroadcast() {
  const h = await bootHarness({ conversations: { driver: 'memory' }, plugin: { agents: [Support, Lookup, Classifier] } })
  const driver = new MemoryQueueDriver()
  h.app.container.instance('queue', createQueueManager({ default: 'memory', drivers: { memory: () => driver } }))
  const broadcast = new BroadcastManager()
  h.app.container.instance('broadcast', broadcast)
  const published: BroadcastEvent[] = []
  broadcast.driver().subscribe(CHANNEL, (event) => {
    published.push(event)
  })
  const responded: AgentResponded[] = []
  h.app.container.make<EventManager>('events').on(AgentResponded, (event) => {
    responded.push(event)
  })
  const failures: Error[] = []
  const work = () =>
    new Worker(driver, { container: h.app.container, stopWhenEmpty: true, sleep: 0 }, {
      jobFailed: (_job, error) => failures.push(error),
    }).start()
  const chunks = () => published.map((event) => [event.event, (event.data as { type: string }).type])
  return { h, published, responded, failures, work, chunks }
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

  test('should refuse an agent with an output schema, and a missing broadcast binding, before dispatching', async () => {
    const { h } = await bootBroadcast()
    await expect(h.app.container.make('ai').agent(Classifier).as(USER).broadcast('x', CHANNEL)).rejects.toThrow('declares an output schema')

    const bare = await bootHarness({ plugin: { agents: [Support] } })
    await expect(bare.app.container.make('ai').agent(Support).as(USER).broadcast('x', CHANNEL)).rejects.toThrow(
      'publishes through the `broadcast` binding',
    )
  })
})
