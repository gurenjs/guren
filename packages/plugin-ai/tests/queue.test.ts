process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, test } from 'bun:test'
import {
  MemoryQueueDriver,
  Worker,
  createQueueManager,
  type AgentPrincipal,
  type EventManager,
  type QueuedJob,
} from '@guren/core'

import { Agent, AgentResponded, RunAgentJob, type RunAgentPayload } from '../src'
import { bootHarness, type Harness } from './fixture'

class Support extends Agent {
  static override agentName = 'support'
  instructions = 'Help.'
}

class Unregistered extends Agent {
  static override agentName = 'unregistered'
  instructions = 'x'
}

const USER: AgentPrincipal = { kind: 'user', id: 7, abilities: ['tickets.read'] }

async function bootQueued(options: Parameters<typeof bootHarness>[0] = {}) {
  const h = await bootHarness({ conversations: { driver: 'memory' }, plugin: { agents: [Support] }, ...options })
  const driver = new MemoryQueueDriver()
  h.app.container.instance('queue', createQueueManager({ default: 'memory', drivers: { memory: () => driver } }))
  const responded: AgentResponded[] = []
  h.app.container.make<EventManager>('events').on(AgentResponded, (event) => {
    responded.push(event)
  })
  const failures: Error[] = []
  const work = async () => {
    const worker = new Worker(driver, { container: h.app.container, stopWhenEmpty: true, sleep: 0 }, {
      jobFailed: (_job, error) => failures.push(error),
    })
    await worker.start()
  }
  return { h, driver, responded, failures, work }
}

async function queuedJobs(driver: MemoryQueueDriver): Promise<QueuedJob[]> {
  const jobs: QueuedJob[] = []
  for (let job = await driver.pop('default'); job; job = await driver.pop('default')) jobs.push(job)
  for (const job of jobs) await driver.release(job, 0)
  return jobs
}

function ai(h: Harness) {
  return h.app.container.make('ai')
}

describe('queue()', () => {
  test('should run the prompt on a worker and emit AgentResponded with the answer', async () => {
    const { h, driver, responded, failures, work } = await bootQueued()
    const model = h.script([{ text: 'queued answer' }])

    const run = await ai(h).agent(Support).as(USER).queue('Ticket #4812', { provider: 'main' })

    expect(model.doGenerateCalls).toHaveLength(0)
    const [job] = await queuedJobs(driver)
    expect(job!.id).toBe(run.jobId)
    expect(job!.name).toBe('RunAgentJob')
    expect(job!.payload).toEqual({ agentName: 'support', input: 'Ticket #4812', principal: USER, provider: 'main' })
    expect(run.conversationId).toBeUndefined()

    await work()

    expect(failures).toEqual([])
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(responded).toHaveLength(1)
    expect(responded[0]!.agentName).toBe('support')
    expect(responded[0]!.principal).toEqual(USER)
    expect(responded[0]!.conversationId).toBeUndefined()
    expect(responded[0]!.response).toMatchObject({ text: 'queued answer', output: 'queued answer', finishReason: 'stop' })
    expect(Object.keys(responded[0]!.response)).not.toContain('steps')
  })

  test('should return the id of a conversation it starts, and have the worker create it under that id', async () => {
    const { h, responded, failures, work } = await bootQueued()
    h.script([{ text: 'first answer' }])

    const run = await ai(h).agent(Support).as(USER).queue('first question', { conversation: true })
    await work()

    expect(failures).toEqual([])
    expect(run.conversationId).toBeString()
    expect(responded[0]!.conversationId).toBe(run.conversationId)
    const stored = await ai(h).conversations().load(run.conversationId!, USER)
    expect(stored?.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  test('should append to a conversation continued through continue()', async () => {
    const { h, failures, work } = await bootQueued()
    const model = h.script([{ text: 'first answer' }, { text: 'second answer' }])
    const support = ai(h).agent(Support).as(USER)
    const first = await support.prompt('first question', { conversation: true })

    const run = await support.continue(first.conversationId!).queue('second question')
    await work()

    expect(failures).toEqual([])
    expect(run.conversationId).toBe(first.conversationId)
    expect(model.doGenerateCalls[1]!.prompt.slice(1).map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    const stored = await ai(h).conversations().load(first.conversationId!, USER)
    expect(stored?.messages).toHaveLength(4)
  })

  test('should refuse a class aiPlugin({ agents }) does not register, before dispatching', async () => {
    const { h, driver } = await bootQueued()

    await expect(ai(h).agent(Unregistered).as(USER).queue('x')).rejects.toThrow(
      'No agent named "unregistered" is registered. A queued run resolves its class through aiPlugin({ agents }), which registers: support.',
    )
    expect(await queuedJobs(driver)).toEqual([])
  })

  test('should refuse a class sharing the registered agentName, since the worker would run the other one', async () => {
    class Impostor extends Agent {
      static override agentName = 'support'
      instructions = 'Not support.'
    }
    const { h, driver } = await bootQueued()

    await expect(ai(h).agent(Impostor).as(USER).queue('x')).rejects.toThrow('registers a different class under "support" than Impostor')
    expect(await queuedJobs(driver)).toEqual([])
  })

  test('should refuse a conversation under as(null) before dispatching', async () => {
    const { h, driver } = await bootQueued()

    await expect(ai(h).agent(Support).as(null).queue('x', { conversation: true })).rejects.toThrow('under as(null)')
    expect(await queuedJobs(driver)).toEqual([])
  })

  test('should refuse a conversation option that contradicts continue()', async () => {
    const { h } = await bootQueued()

    await expect(ai(h).agent(Support).as(USER).continue('a').queue('x', { conversation: 'b' })).rejects.toThrow(
      'bound to conversation "a" by continue()',
    )
  })

  test('should name the missing queue binding', async () => {
    const h = await bootHarness({ plugin: { agents: [Support] } })

    await expect(ai(h).agent(Support).as(USER).queue('x')).rejects.toThrow('dispatches through the `queue` binding')
  })

  test('should fail the job, naming the registered agents, for a name no longer registered', async () => {
    const { h, driver, failures, work } = await bootQueued()
    const payload: RunAgentPayload = { agentName: 'renamed', input: 'x', principal: USER }
    await h.app.container.make('queue').dispatch(RunAgentJob, payload)
    expect(await queuedJobs(driver)).toHaveLength(1)

    await work()

    expect(failures.map((error) => error.message)).toEqual([
      'No agent named "renamed" is registered. A queued run resolves its class through aiPlugin({ agents }), which registers: support.',
    ])
  })
})

describe('aiPlugin({ agents })', () => {
  test('should refuse two classes under one agentName at boot', async () => {
    class Other extends Agent {
      static override agentName = 'support'
      instructions = 'x'
    }

    await expect(bootHarness({ plugin: { agents: [Support, Other] } })).rejects.toThrow(
      'aiPlugin({ agents }) registers two agents named "support" (Support and Other).',
    )
  })

  test('should refuse an agent carrying the shared anonymous name at boot', async () => {
    class Nameless extends Agent {
      static override agentName = 'anonymous'
      instructions = 'x'
    }

    await expect(bootHarness({ plugin: { agents: [Nameless] } })).rejects.toThrow('cannot register an agent named "anonymous"')
  })
})
