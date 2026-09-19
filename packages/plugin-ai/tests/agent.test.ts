process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, test } from 'bun:test'
import { createApp, type Application } from '@guren/core'
import { Experimental_EvaluationMockModelV4 } from 'ai/test'
import { z } from 'zod'

import { Agent, Output, agent, defineAiConfig, evaluate, resolveAgentName, type AiProviderConfig } from '../src'
import { bootHarness, scriptedModel } from './fixture'

const Triage = z.object({ category: z.enum(['billing', 'bug']), priority: z.number().int() })

class Triager extends Agent {
  static override agentName = 'triager'
  instructions = 'Triage the ticket.'
  output = Output.object({ schema: Triage })
}

class Greeter extends Agent {
  instructions = 'Say hello.'
}

describe('Agent.prompt', () => {
  test('should return the model text, usage and steps, with output falling back to the text', async () => {
    const h = await bootHarness()
    const model = h.script([{ text: 'Hello there.' }])

    const response = await h.app.container.make('ai').agent(Greeter).as(null).prompt('Hi')

    const text: string = response.output
    // @ts-expect-error an agent declaring no output schema answers with a string, not an object
    void response.output.priority
    expect(text).toBe('Hello there.')
    expect(response.text).toBe('Hello there.')
    expect(response.steps).toHaveLength(1)
    expect(response.usage.inputTokens).toBe(3)
    expect(model.doGenerateCalls[0]!.prompt[0]).toEqual({ role: 'system', content: 'Say hello.' })
  })

  test('should parse a structured output against the class schema', async () => {
    const h = await bootHarness()
    h.script([{ text: '{"category":"billing","priority":2}' }])

    const response = await h.app.container.make('ai').agent(Triager).as({ id: 1 }).prompt('Refund please')

    const priority: number = response.output.priority
    // @ts-expect-error inferred from the class's schema, so the type is not `any`
    const wrong: string = response.output.priority
    void wrong
    expect(priority).toBe(2)
    expect(response.output.category).toBe('billing')
  })

  test('should resolve the provider by name, per call over per class over the default', async () => {
    const h = await bootHarness()
    h.script([{ text: 'from main' }])

    class Judged extends Agent {
      instructions = 'Judge.'
      override provider = 'judge'
    }
    const ai = h.app.container.make('ai')

    expect((await ai.agent(Judged).as(null).prompt('x')).text).toBe('from the judge provider')
    expect((await ai.agent(Greeter).as(null).prompt('x', { provider: 'main' })).text).toBe('from main')
  })

  test('should name the configured providers when asked for one that is not', async () => {
    const h = await bootHarness()

    await expect(h.app.container.make('ai').agent(Greeter).as(null).prompt('x', { provider: 'nope' }))
      .rejects.toThrow('No AI provider named "nope" is configured. config/ai.ts configures: main, judge.')
  })
})

describe('Agent construction', () => {
  test('should refuse a bare new, which has no application or principal', () => {
    expect(() => new Greeter()).toThrow('Greeter is constructed by as(principal)')
  })

  test('should set the container and principal before tools() and member initializers run', async () => {
    const h = await bootHarness()
    const seen: unknown[] = []

    class Introspective extends Agent {
      instructions = 'x'
      readonly boundApp = this.make('app')
      override tools() {
        seen.push(this.principal, this.boundApp === h.app)
        return {}
      }
    }

    h.app.container.make('ai').agent(Introspective).as({ id: 9, kind: 'service', abilities: ['tools:read'] })

    expect(seen).toEqual([{ kind: 'service', id: 9, abilities: ['tools:read'] }, true])
  })

  test('should carry only kind, id and abilities from a user record across the seam', async () => {
    const h = await bootHarness()
    const bound = h.app.container.make('ai').agent(Greeter)
      .as({ id: 'u-1', email: 'someone@example.com', role: 'admin' } as { id: string })

    expect(bound.agent.principal).toEqual({ kind: 'user', id: 'u-1' })
  })

  test('should refuse a principal without a usable id', async () => {
    const h = await bootHarness()

    expect(() => h.app.container.make('ai').agent(Greeter).as({ id: undefined } as unknown as { id: string }))
      .toThrow('string or number `id`')
  })

  test('should read only an own agentName, defaulting to the class name', () => {
    class Child extends Triager {}

    expect(resolveAgentName(Triager)).toBe('triager')
    expect(resolveAgentName(Child)).toBe('Child')
    expect(resolveAgentName(Greeter)).toBe('Greeter')
  })

  test('should build a one-off agent with agent()', async () => {
    const h = await bootHarness()
    h.script([{ text: 'one-off' }])
    const OneOff = agent({ instructions: 'Be brief.', agentName: 'one-off' })

    expect(resolveAgentName(OneOff)).toBe('one-off')
    expect((await h.app.container.make('ai').agent(OneOff).as(null).prompt('x')).text).toBe('one-off')
  })
})

describe('Agent statics: the ambient form', () => {
  test('should resolve the manager from the default application', async () => {
    const h = await bootHarness()
    h.script([{ text: 'ambient' }])

    expect((await Greeter.prompt('x')).text).toBe('ambient')
    expect(Greeter.as({ id: 3 }).agent.principal).toEqual({ kind: 'user', id: 3 })
  })

  test('should explain the missing config when the default application binds no ai manager', async () => {
    const app: Application = createApp({})
    await app.boot()

    expect(() => Greeter.as(null)).toThrow('Add config/ai.ts (defineAiConfig) to createApp({ config })')
  })
})

describe('defineAiConfig and AiManager', () => {
  async function bootWith(providers: Record<string, AiProviderConfig>, defaultName: string): Promise<Application> {
    const app = createApp({ config: [defineAiConfig(() => ({ default: defaultName, providers }))] })
    await app.boot()
    return app
  }

  test('should fail the boot when the default provider is not configured', async () => {
    const model = scriptedModel([{ text: 'x' }])

    await expect(bootWith({ main: { model: () => model } }, 'anthropic')).rejects.toThrow(
      'config/ai.ts names "anthropic" as its default provider, but configures only: main.',
    )
  })

  test('should call a provider factory once and memoize the model', async () => {
    let built = 0
    const app = await bootWith({ main: { model: () => (built++, scriptedModel([])) } }, 'main')
    const ai = app.container.make('ai')

    expect(ai.model()).toBe(ai.model('main'))
    expect(built).toBe(1)
  })

  test('should refuse an embedding model the provider does not configure', async () => {
    const app = await bootWith({ main: { model: () => scriptedModel([]) } }, 'main')

    expect(() => app.container.make('ai').embeddingModel()).toThrow(
      'The AI provider "main" configures no embeddingModel in config/ai.ts.',
    )
  })

  test('should refuse a language model from a provider configured for evaluation alone', async () => {
    const app = await bootWith({ main: { model: () => scriptedModel([]) }, jev: { evaluationModel: () => evaluationModel() } }, 'main')

    expect(() => app.container.make('ai').model('jev')).toThrow('The AI provider "jev" configures no model in config/ai.ts.')
    expect(() => app.container.make('ai').evaluationModel('main')).toThrow(
      'The AI provider "main" configures no evaluationModel in config/ai.ts.',
    )
  })

  test('should fail the boot when defaultEvaluation names no provider', async () => {
    const app = createApp({
      config: [defineAiConfig(() => ({ default: 'main', defaultEvaluation: 'jev', providers: { main: { model: () => scriptedModel([]) } } }))],
    })

    await expect(app.boot()).rejects.toThrow(
      'config/ai.ts names "jev" as its defaultEvaluation provider, but configures only: main.',
    )
  })

  test('should evaluate through defaultEvaluation, memoizing its model', async () => {
    let built = 0
    const app = createApp({
      config: [defineAiConfig(() => ({
        default: 'main',
        defaultEvaluation: 'jev',
        providers: {
          main: { model: () => scriptedModel([]) },
          jev: { evaluationModel: () => (built++, evaluationModel()) },
        },
      }))],
    })
    await app.boot()
    const ai = app.container.make('ai')

    const result = await evaluate({
      manager: ai,
      state: 'I was charged twice.',
      questions: {
        team: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, technical: null } },
        urgent: { type: 'boolean', instructions: 'Urgent?' },
      },
    })

    expect(result.answers.team.choice).toBe('billing')
    expect(result.answers.urgent.probability).toBe(0.25)
    expect(ai.evaluationModel()).toBe(ai.evaluationModel('jev'))
    expect(built).toBe(1)
  })

  test('should fall back to the default provider for evaluation when defaultEvaluation is absent', async () => {
    const app = await bootWith({ main: { model: () => scriptedModel([]), evaluationModel: () => evaluationModel() } }, 'main')

    const result = await evaluate({
      manager: app.container.make('ai'),
      state: 'x',
      questions: { urgent: { type: 'boolean', instructions: 'Urgent?' } },
    })

    expect(result.answers.urgent.probability).toBe(0.25)
  })
})

/** Answers every choice with its first option and every boolean with 0.25. */
function evaluationModel(): Experimental_EvaluationMockModelV4 {
  return new Experimental_EvaluationMockModelV4({
    supportedQuestionTypes: ['choice', 'score', 'boolean'],
    doEvaluate: async ({ questions }) => ({
      answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
        if (question.type === 'choice') {
          const options = Object.keys(question.criteria)
          return [id, { type: 'choice', choice: options[0]!, probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 1 : 0])) }]
        }
        if (question.type === 'score') return [id, { type: 'score', score: 0 }]
        return [id, { type: 'boolean', probability: 0.25 }]
      })),
      warnings: [],
    }),
  })
}
