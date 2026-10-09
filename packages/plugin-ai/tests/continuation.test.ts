process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, test } from 'bun:test'
import { jsonSchema, type Tool } from 'ai'

import { Agent, agent, isPausedTurn, type AgentCallSettings, type ContinueCondition } from '../src'
import { bootHarness, USAGE, type GenerateResult } from './fixture'

// A provider-executed tool, shaped as a provider package builds one, so no provider is imported.
const webSearch = {
  type: 'provider',
  id: 'test.web_search',
  args: {},
  inputSchema: jsonSchema({ type: 'object', properties: { query: { type: 'string' } } }),
} as unknown as Tool

function paused(index: number, text = ''): GenerateResult {
  return {
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      { type: 'tool-call', toolCallId: `search-${index}`, toolName: 'web_search', input: '{"query":"e100"}', providerExecuted: true },
      { type: 'tool-result', toolCallId: `search-${index}`, toolName: 'web_search', result: [{ url: `https://example.org/${index}` }] },
      { type: 'source', sourceType: 'url', id: `source-${index}`, url: `https://example.org/${index}`, title: `Page ${index}` },
    ],
    finishReason: { unified: 'stop', raw: 'pause_turn' },
    usage: USAGE,
    warnings: [],
  }
}

function answered(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'end_turn' },
    usage: USAGE,
    warnings: [],
    providerMetadata: { test: { usage: { server_tool_use: { web_search_requests: 1 } } } },
    response: { modelId: 'test-model-2026' },
  }
}

class Researcher extends Agent {
  static override agentName = 'researcher'
  instructions = 'Research the additive.'
  override continueWhen = isPausedTurn
  override tools() {
    return { web_search: webSearch }
  }
}

describe('Agent settings', () => {
  test('should send the class settings with every model call', async () => {
    const h = await bootHarness()
    const model = h.script([{ text: 'ok' }])

    class Capped extends Agent {
      instructions = 'Answer briefly.'
      override settings: AgentCallSettings = {
        maxOutputTokens: 1_000,
        temperature: 0,
        providerOptions: { anthropic: { effort: 'low', cacheControl: { type: 'ephemeral' } } },
      }
    }
    await h.manager.agent(Capped).as(null).prompt('Hi')

    const call = model.doGenerateCalls[0]!
    expect(call.maxOutputTokens).toBe(1_000)
    expect(call.temperature).toBe(0)
    expect(call.providerOptions).toEqual({ anthropic: { effort: 'low', cacheControl: { type: 'ephemeral' } } })
  })

  test('should keep the class instructions over a settings key that names them', async () => {
    const h = await bootHarness()
    const model = h.script([{ text: 'ok' }])

    const Anonymous = agent({
      instructions: 'The class instructions.',
      settings: { maxOutputTokens: 50, instructions: 'smuggled' } as AgentCallSettings,
    })
    await h.manager.agent(Anonymous).as(null).prompt('Hi')

    expect(model.doGenerateCalls[0]!.maxOutputTokens).toBe(50)
    expect(model.doGenerateCalls[0]!.prompt[0]).toEqual({ role: 'system', content: 'The class instructions.' })
  })
})

describe('AgentResponse details', () => {
  test('should carry the sources, final provider metadata, model id and raw finish reason', async () => {
    const h = await bootHarness()
    h.scriptResults([answered('E100 is curcumin.')])

    class Plain extends Agent {
      instructions = 'Answer.'
    }
    const response = await h.manager.agent(Plain).as(null).prompt('What is E100?')

    expect(response.modelId).toBe('test-model-2026')
    expect(response.rawFinishReason).toBe('end_turn')
    expect(response.providerMetadata).toEqual({ test: { usage: { server_tool_use: { web_search_requests: 1 } } } })
    expect(response.sources).toEqual([])
  })
})

describe('continueWhen', () => {
  test('should resume a paused turn with the paused response appended and no new user message', async () => {
    const h = await bootHarness()
    const model = h.scriptResults([paused(1, 'Searching. '), answered('Done.')])

    const response = await h.manager.agent(Researcher).as(null).prompt('Check E100')

    expect(model.doGenerateCalls).toHaveLength(2)
    const resumed = model.doGenerateCalls[1]!.prompt
    expect(resumed.map((message) => message.role)).toEqual(['system', 'user', 'assistant'])
    expect(resumed.at(-1)!.content).toContainEqual(expect.objectContaining({ type: 'tool-call', toolCallId: 'search-1', providerExecuted: true }))
    expect(response.text).toBe('Searching. Done.')
    expect(response.output).toBe('Searching. Done.')
    expect(response.steps).toHaveLength(2)
    expect(response.usage.inputTokens).toBe(6)
    expect(response.usage.inputTokenDetails.noCacheTokens).toBe(6)
    expect(response.usage.outputTokens).toBe(4)
    expect(response.sources.map((source) => source.sourceType === 'url' && source.url)).toEqual(['https://example.org/1'])
    expect(response.finishReason).toBe('stop')
    expect(response.rawFinishReason).toBe('end_turn')
  })

  test('should stop after maxContinuations and report the turn still paused', async () => {
    const h = await bootHarness()
    const model = h.scriptResults([paused(1), paused(2), paused(3), paused(4)])

    class Bounded extends Researcher {
      override maxContinuations = 2
    }
    const response = await h.manager.agent(Bounded).as(null).prompt('Check E100')

    expect(model.doGenerateCalls).toHaveLength(3)
    expect(response.rawFinishReason).toBe('pause_turn')
    expect(response.sources).toHaveLength(3)
  })

  test('should not continue an agent that declares no continueWhen', async () => {
    const h = await bootHarness()
    const model = h.scriptResults([paused(1, 'Searching. '), answered('Done.')])

    const Plain = agent({ instructions: 'Research.', tools: () => ({ web_search: webSearch }) })
    const response = await h.manager.agent(Plain).as(null).prompt('Check E100')

    expect(model.doGenerateCalls).toHaveLength(1)
    expect(response.rawFinishReason).toBe('pause_turn')
    expect(response.text).toBe('Searching. ')
  })

  test('should take the last round text alone when the continuation went on to more steps', async () => {
    const h = await bootHarness()
    const model = h.scriptResults([
      paused(1, 'Searching. '),
      { content: [{ type: 'tool-call', toolCallId: 'lookup-1', toolName: 'lookup', input: '{}' }], finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: USAGE, warnings: [] },
      answered('Done.'),
    ])

    class WithLookup extends Researcher {
      override tools() {
        return { ...super.tools(), lookup: { inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'found' } as Tool }
      }
    }
    const response = await h.manager.agent(WithLookup).as(null).prompt('Check E100')

    expect(model.doGenerateCalls).toHaveLength(3)
    expect(response.text).toBe('Done.')
    expect(response.steps).toHaveLength(3)
  })

  test('should store the user message and every round once, in a conversation', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    h.scriptResults([paused(1), answered('Done.')])

    const response = await h.manager.agent(Researcher).as({ id: 7 }).prompt('Check E100', { conversation: true })

    const stored = await h.manager.conversations().load(response.conversationId!, { kind: 'user', id: 7 })
    expect(stored!.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant'])
  })

  test('should fail the turn, storing nothing, when aborted between calls', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    const model = h.scriptResults([paused(1), answered('Done.')])
    const controller = new AbortController()

    const abortThenContinue: ContinueCondition = (step) => {
      controller.abort()
      return isPausedTurn(step)
    }
    const Aborting = agent({ agentName: 'aborting', instructions: 'Research.', tools: () => ({ web_search: webSearch }), continueWhen: abortThenContinue })
    const bound = h.manager.agent(Aborting).as({ id: 7 })

    await expect(bound.prompt('Check E100', { conversation: true, signal: controller.signal })).rejects.toThrow(/abort/i)
    expect(model.doGenerateCalls).toHaveLength(1)
  })
})
