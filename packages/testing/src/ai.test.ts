// Set before anything imports @guren/core: the CSRF middleware needs a signing key.
process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BroadcastManager, Controller, MemoryQueueDriver, Worker, createApp, createCsrfMiddleware, createQueueManager, type Router } from '@guren/core'
import { Agent, Output, aiPlugin, defineAiConfig, embed, embedMany, evaluate, image, stepCountIs, type AgentToolScope } from '@guren/plugin-ai'
import { TestApp } from './test-app'

/**
 * `fakeAi()` against a real application, `config/ai.ts` and `aiPlugin()`: the
 * scripted model replaces the provider, and tools still dispatch through the
 * invocation pipeline into the routes below.
 */
const created: string[] = []

class Summarizer extends Agent {
  static override agentName = 'summarizer'
  instructions = 'Summarize.'
}

class Triager extends Agent {
  static override agentName = 'triager'
  instructions = 'Triage.'
  output = Output.object({ schema: z.object({ priority: z.number().int() }) })
}

class Writer extends Agent {
  static override agentName = 'writer'
  static override scopes: readonly AgentToolScope[] = ['tool:posts_store', 'tool:posts_publish']
  instructions = 'Write posts.'

  override tools() {
    return this.appTools(['posts_store', 'posts_publish'])
  }
}

class OneStepWriter extends Writer {
  static override agentName = 'one-step-writer'
  override stopWhen = stepCountIs(1)
}

class NeverScripted extends Agent {
  static override agentName = 'never-scripted'
  instructions = 'x'
}

class AiController extends Controller {
  async summarize() {
    const { text } = await this.validateBody(z.object({ text: z.string() }))
    const response = await this.make('ai').agent(Summarizer).as(null).prompt(text)
    return this.json({ summary: response.text })
  }

  async index() {
    const { text } = await this.validateBody(z.object({ text: z.string() }))
    // The ambient form: no manager passed, so the binding fakeAi() replaced is the one resolved.
    const { embedding } = await embed({ value: text })
    return this.json({ embedding })
  }

  async unscripted() {
    const response = await this.make('ai').agent(NeverScripted).as(null).prompt('hello')
    return this.json({ text: response.text })
  }
}

function routes(router: Router): void {
  router.post('/summarize', [AiController, 'summarize'])
  router.post('/embed', [AiController, 'index'])
  router.post('/unscripted', [AiController, 'unscripted'])
  router
    .post('/posts', { body: z.object({ title: z.string() }) }, ({ body }) => {
      created.push(body.title)
      return Response.json({ created: body.title })
    })
    .name('posts_store')
    .agent({ description: 'Create a post' })
  router
    .post('/posts/:id/publish', { params: z.object({ id: z.coerce.number() }) }, ({ params }) =>
      Response.json({ published: params.id }))
    .name('posts_publish')
    .agent({ description: 'Publish a post', approval: 'required' })
}

let app: TestApp
let application: ReturnType<typeof createApp>

beforeAll(async () => {
  application = createApp({
    routes,
    config: [
      defineAiConfig(() => ({
        default: 'main',
        providers: {
          main: {
            model: () => {
              throw new Error('the real provider was reached')
            },
            embeddingModel: () => {
              throw new Error('the real provider was reached')
            },
            imageModel: () => {
              throw new Error('the real provider was reached')
            },
            evaluationModel: () => {
              throw new Error('the real provider was reached')
            },
          },
          // Configures no language model: what a provider added for Jev alone has.
          evalOnly: {
            evaluationModel: () => {
              throw new Error('the real provider was reached')
            },
          },
          // Configures a language model only: what an app using Anthropic has.
          bare: {
            model: () => {
              throw new Error('the real provider was reached')
            },
          },
        },
        conversations: { driver: 'memory' },
      })),
    ],
    providers: [aiPlugin({ agents: [Summarizer, Writer] })],
  })
  application.use('*', createCsrfMiddleware({ exclude: ['/summarize', '/embed', '/unscripted'] }))
  app = await TestApp.fromApp(application)
})

beforeEach(() => {
  created.length = 0
})

describe('TestApp.fakeAi', () => {
  it('should answer a prompt made inside a request with the scripted text and record its input', async () => {
    using ai = app.fakeAi()
    ai.respond(Summarizer, ['A short summary.'])

    await app.post('/summarize', { text: 'Ticket #4812: refund' }).assertOk().assertJson({ summary: 'A short summary.' })

    ai.assertPrompted(Summarizer)
    ai.assertPrompted(Summarizer, (input) => input.includes('#4812'))
    ai.assertNotPrompted(Summarizer, (input) => input.includes('#9999'))
    ai.assertNeverPrompted(Triager)
    expect(ai.calls(Summarizer).map((call) => call.input)).toEqual(['Ticket #4812: refund'])
  })

  it('should parse a scripted output against the agent schema', async () => {
    using ai = app.fakeAi()
    ai.respond(Triager, [{ output: { priority: 2 } }, { output: { priority: 4 } }])
    const factory = application.container.make('ai').agent(Triager)

    const first = await factory.as(null).prompt('one')
    const second = await factory.as(null).prompt('two')

    expect([first.output.priority, second.output.priority]).toEqual([2, 4])
    expect(ai.calls(Triager)).toHaveLength(2)
  })

  it('should run the requested tools for real through the pipeline', async () => {
    using ai = app.fakeAi()
    ai.respond(Writer, [{
      toolCalls: [
        { name: 'posts_store', input: { title: 'Hello' } },
        { name: 'posts_publish', input: { id: 3 } },
      ],
      then: 'Created, publish is pending approval.',
    }])

    const response = await application.container.make('ai').agent(Writer).as({ id: 1 }).prompt('Write it')

    expect(response.text).toBe('Created, publish is pending approval.')
    expect(created).toEqual(['Hello'])
    const [store, publish] = ai.calls(Writer)[0]!.toolCalls
    expect(store).toMatchObject({ name: 'posts_store', input: { title: 'Hello' }, output: { created: 'Hello' } })
    // The approval gate is unconfigured, so it refuses: proof the call went through the pipeline.
    expect(publish).toMatchObject({ name: 'posts_publish', output: { denied: expect.any(String) } })
  })

  it('should fail an unscripted prompt, naming the agent, even when the route swallows it as a 500', async () => {
    const ai = app.fakeAi()

    await app.post('/unscripted', {}).assertStatus(500)
    expect(ai.calls(NeverScripted)).toHaveLength(1)
    expect(() => ai[Symbol.dispose]()).toThrow('Agent [never-scripted] was prompted, but nothing is scripted')
  })

  it('should fail a prompt past the end of the agent script', async () => {
    const ai = app.fakeAi()
    ai.respond(Writer, [{ toolCalls: [{ name: 'posts_store', input: { title: 'x' } }], then: { text: 'done' } }])
    ai.respond(Writer, [{ text: 'only' }])
    const factory = application.container.make('ai').agent(Writer)

    await expect(factory.as({ id: 1 }).prompt('first')).resolves.toMatchObject({ text: 'done' })
    await expect(factory.as({ id: 1 }).prompt('second')).resolves.toMatchObject({ text: 'only' })
    await expect(factory.as({ id: 1 }).prompt('third')).rejects.toThrow('Agent [writer] was prompted, but nothing is scripted')
    expect(() => ai[Symbol.dispose]()).toThrow('fakeAi() found calls its script did not answer')
  })

  it('should consume one response per prompt on the same bound agent', async () => {
    using ai = app.fakeAi()
    ai.respond(Summarizer, ['first', 'second'])
    const bound = application.container.make('ai').agent(Summarizer).as(null)

    const answers = [(await bound.prompt('a')).text, (await bound.prompt('b')).text]

    expect(answers).toEqual(['first', 'second'])
  })

  it('should fail on dispose when the loop stops before the scripted answer', async () => {
    const ai = app.fakeAi()
    ai.respond(OneStepWriter, [{ toolCalls: [{ name: 'posts_store', input: { title: 'x' } }], then: 'never read' }])

    await application.container.make('ai').agent(OneStepWriter).as({ id: 1 }).prompt('write')

    expect(() => ai[Symbol.dispose]()).toThrow('Agent [one-step-writer] stopped after 1 of its 2 scripted steps')
  })

  it('should keep an outer fake in place when a nested one is disposed', () => {
    using outer = app.fakeAi()
    {
      using _inner = app.fakeAi()
    }

    expect(application.container.make('ai')).toBe(outer)
  })

  it('should report what was prompted when an assertion fails', () => {
    using ai = app.fakeAi()

    expect(() => ai.assertPrompted(Summarizer)).toThrow('Expected agent [summarizer] to be prompted, but it was not.')
    expect(() => ai.assertNeverPrompted(Summarizer)).not.toThrow()
  })

  it('should fail assertNotPrompted and assertNeverPrompted on a matching prompt', async () => {
    using ai = app.fakeAi()
    ai.respond(Summarizer, ['ok'])

    await application.container.make('ai').agent(Summarizer).as(null).prompt('secret plan')

    expect(() => ai.assertNotPrompted(Summarizer, (input) => input.includes('secret')))
      .toThrow('Unexpected prompt of agent [summarizer] with matching input: "secret plan".')
    expect(() => ai.assertNeverPrompted(Summarizer))
      .toThrow('Expected agent [summarizer] never to be prompted, but it was prompted 1 time(s).')
    expect(() => ai.assertPrompted(Summarizer, (input) => input === 'other'))
      .toThrow('It was prompted with: "secret plan".')
  })

  it('should record prompts made through continue() and keep the conversation in the configured store', async () => {
    using ai = app.fakeAi()
    ai.respond(Summarizer, ['first summary', 'second summary'])
    const summarizer = application.container.make('ai').agent(Summarizer).as({ id: 1 })

    const first = await summarizer.prompt('first', { conversation: true })
    const second = await summarizer.continue(first.conversationId!).prompt('second')

    expect(second.conversationId).toBe(first.conversationId)
    expect(ai.calls(Summarizer).map((call) => call.input)).toEqual(['first', 'second'])
    const stored = await ai.conversations().load(first.conversationId!, { kind: 'user', id: 1 })
    expect(stored!.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('should record a queued prompt when the worker runs it, not when it is queued', async () => {
    using ai = app.fakeAi()
    ai.respond(Summarizer, ['queued summary'])
    const driver = new MemoryQueueDriver()
    application.container.instance('queue', createQueueManager({ drivers: { memory: () => driver } }))

    await application.container.make('ai').agent(Summarizer).as({ id: 1 }).queue('long text')
    ai.assertNeverPrompted(Summarizer)
    await new Worker(driver, { container: application.container, stopWhenEmpty: true, sleep: 0 }).start()

    expect(ai.calls(Summarizer).map((call) => [call.input, call.response?.text])).toEqual([['long text', 'queued summary']])
  })

  it('should record a broadcast run and the tools it ran when the worker streams it', async () => {
    using ai = app.fakeAi()
    ai.respond(Writer, [{ toolCalls: [{ name: 'posts_store', input: { title: 'Broadcast' } }], then: 'Created it.' }])
    const driver = new MemoryQueueDriver()
    application.container.instance('queue', createQueueManager({ drivers: { memory: () => driver } }))
    const broadcast = new BroadcastManager()
    application.container.instance('broadcast', broadcast)
    const types: string[] = []
    broadcast.driver().subscribe('private-writer.1', (event) => {
      types.push((event.data as { type: string }).type)
    })

    await application.container.make('ai').agent(Writer).as({ id: 1 }).broadcast('Write it', 'private-writer.1')
    await new Worker(driver, { container: application.container, stopWhenEmpty: true, sleep: 0 }).start()

    expect(created).toEqual(['Broadcast'])
    expect(types.at(-1)).toBe('finish')
    expect(ai.calls(Writer).map((call) => [call.input, call.toolCalls.map((recorded) => recorded.name)])).toEqual([
      ['Write it', ['posts_store']],
    ])
  })

  it('should refuse an anonymous conversation without consuming a scripted response', async () => {
    using ai = app.fakeAi()
    ai.respond(Summarizer, ['kept for the next prompt'])
    const summarizer = application.container.make('ai').agent(Summarizer)

    await expect(summarizer.as(null).prompt('x', { conversation: true })).rejects.toThrow('under as(null)')
    expect((await summarizer.as(null).prompt('y')).text).toBe('kept for the next prompt')
  })

  it('should stream a scripted answer and record the tools it ran once the body is read', async () => {
    using ai = app.fakeAi()
    ai.respond(Writer, [{ toolCalls: [{ name: 'posts_store', input: { title: 'Streamed' } }], then: 'Created it.' }])

    const response = await application.container.make('ai').agent(Writer).as({ id: 1 }).stream('Write it')
    const body = await response.text()

    expect(body).toContain('"delta":"Created it."')
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(created).toEqual(['Streamed'])
    expect(ai.calls(Writer)[0]!.toolCalls).toEqual([
      { name: 'posts_store', input: { title: 'Streamed' }, output: { created: 'Streamed' } },
    ])
  })

  it('should record a stream made through continue()', async () => {
    using ai = app.fakeAi()
    ai.respond(Summarizer, ['first', 'second'])
    const summarizer = application.container.make('ai').agent(Summarizer).as({ id: 1 })

    const first = await summarizer.stream('one', { conversation: true })
    expect(first.headers.get('X-Guren-Conversation')).toMatch(/^[0-9a-f-]{36}$/)
    await first.text()
    await (await summarizer.continue(first.headers.get('X-Guren-Conversation')!).stream('two')).text()

    expect(ai.calls(Summarizer).map((call) => call.input)).toEqual(['one', 'two'])
  })

  it('should restore the real manager on dispose', async () => {
    {
      using ai = app.fakeAi()
      expect(application.container.make('ai')).toBe(ai)
    }

    await expect(application.container.make('ai').agent(Summarizer).as(null).prompt('x'))
      .rejects.toThrow('the real provider was reached')
  })

  it('should answer an embed() made inside a request from the script', async () => {
    using ai = app.fakeAi()
    ai.respondEmbeddings([[0.1, 0.2]])

    await app.post('/embed', { text: 'a ticket' }).assertOk().assertJson({ embedding: [0.1, 0.2] })

    ai.assertEmbedded()
    ai.assertEmbedded((call) => call.values.includes('a ticket'))
    expect(ai.embedCalls()).toEqual([{ values: ['a ticket'], provider: 'main' }])
    ai.assertNeverGeneratedImage()
  })

  it('should draw one scripted vector per value, whatever the batching', async () => {
    using ai = app.fakeAi()
    ai.respondEmbeddings([[1], [2], [3]])
    const manager = application.container.make('ai')

    const many = await embedMany({ values: ['a', 'b'], manager })
    const one = await embed({ value: 'c', manager })

    expect(many.embeddings).toEqual([[1], [2]])
    expect(one.embedding).toEqual([3])
  })

  it('should answer every value from a scripted function', async () => {
    using ai = app.fakeAi()
    ai.respondEmbeddings((value) => [value.length])

    const { embeddings } = await embedMany({ values: ['a', 'bb', 'ccc'], manager: application.container.make('ai') })

    expect(embeddings).toEqual([[1], [2], [3]])
  })

  it('should fail an unscripted embed() once, naming the call', async () => {
    const ai = app.fakeAi()

    await expect(embed({ value: 'x', manager: application.container.make('ai') }))
      .rejects.toThrow('embed() or embedMany() was called, but nothing is scripted for it.')

    expect(() => ai[Symbol.dispose]()).toThrow(/respondEmbeddings/)
  })

  it('should fail an embed() whose script ran out of vectors', async () => {
    const ai = app.fakeAi()
    ai.respondEmbeddings([[1]])

    await expect(embedMany({ values: ['a', 'b'], manager: application.container.make('ai') }))
      .rejects.toThrow('asked for the embedding of "b", and the script is exhausted')

    expect(() => ai[Symbol.dispose]()).toThrow(/script is exhausted/)
  })

  it('should refuse a provider that configures no embeddingModel, as the real manager would', async () => {
    const ai = app.fakeAi()
    ai.respondEmbeddings([[1]])

    await expect(embed({ value: 'x', provider: 'bare', manager: application.container.make('ai') }))
      .rejects.toThrow('resolves the AI provider "bare", which configures no embeddingModel in config/ai.ts.')

    // A refused call is still a call, as a refused prompt is: the assertion must not deny it happened.
    ai.assertEmbedded()
    expect(ai.embedCalls()).toEqual([{ values: [], provider: 'bare' }])
    expect(() => ai[Symbol.dispose]()).toThrow(/configures no embeddingModel/)
  })

  it('should answer evaluate() from the shorthand script and record the call', async () => {
    using ai = app.fakeAi()
    ai.respondEvaluations([{ team: 'billing', urgent: 0.9, severity: 1 }])
    const manager = application.container.make('ai')

    const { answers } = await evaluate({
      manager,
      state: { title: 'Charged twice' },
      questions: {
        team: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, bug: null } },
        urgent: { type: 'boolean', instructions: 'Urgent?' },
        severity: { type: 'score', instructions: 'How bad?', criteria: ['low', 'mid', 'high'] },
      },
    })

    expect(answers.team).toEqual({ type: 'choice', choice: 'billing', probabilities: { billing: 1, bug: 0 } })
    expect(answers.urgent).toEqual({ type: 'boolean', probability: 0.9 })
    expect(answers.severity).toEqual({ type: 'score', score: 1, probabilities: { '0': 0, '1': 1, '2': 0 } })
    ai.assertEvaluated((call) => JSON.stringify(call.state).includes('Charged twice'))
    expect(ai.evaluationCalls()[0]).toMatchObject({ provider: 'main', state: { title: 'Charged twice' } })
    expect(Object.keys(ai.evaluationCalls()[0]!.questions)).toEqual(['team', 'urgent', 'severity'])
    ai.assertNeverEmbedded()
  })

  it('should refuse a scripted value the questions cannot produce, and an unscripted call', async () => {
    const ai = app.fakeAi()
    ai.respondEvaluations([{ team: 'refund' }])
    const manager = application.container.make('ai')
    const questions = { team: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, bug: null } } } as const

    await expect(evaluate({ manager, state: 'x', questions }))
      .rejects.toThrow('ai.respondEvaluations() gives question "team" "refund", not one of its options: billing, bug.')
    expect(String(ai.evaluationCalls()[0]!.error)).toContain('not one of its options')

    await expect(evaluate({ manager, state: 'x', questions }))
      .rejects.toThrow('Script it with ai.respondEvaluations([{ ... }]) before the call.')

    expect(() => ai[Symbol.dispose]()).toThrow(/not one of its options[\s\S]*nothing is scripted/)
  })

  it('should refuse a prompt on a provider that configures no model, as the real manager would', async () => {
    const ai = app.fakeAi()
    ai.respond(Summarizer, ['unreached'])

    await expect(application.container.make('ai').agent(Summarizer).as(null).prompt('x', { provider: 'evalOnly' }))
      .rejects.toThrow('Agent [summarizer] resolves the AI provider "evalOnly", which configures no model in config/ai.ts.')

    expect(() => ai[Symbol.dispose]()).toThrow(/configures no model/)
  })

  it('should refuse a provider that configures no evaluationModel, recording the call', async () => {
    const ai = app.fakeAi()
    ai.respondEvaluations([{ team: 'bug' }])

    await expect(evaluate({
      provider: 'bare',
      manager: application.container.make('ai'),
      state: 'x',
      questions: { team: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, bug: null } } },
    })).rejects.toThrow('evaluate() resolves the AI provider "bare", which configures no evaluationModel in config/ai.ts.')

    ai.assertEvaluated()
    expect(ai.evaluationCalls()).toEqual([{ questions: {}, provider: 'bare' }])
    expect(() => ai[Symbol.dispose]()).toThrow(/configures no evaluationModel/)
  })

  it('should answer image() with the scripted images and record the prompt', async () => {
    using ai = app.fakeAi()
    ai.respondImages(['AAEC', ['AwQF', 'BgcI']])
    const manager = application.container.make('ai')

    const one = await image({ prompt: 'a red fox', manager })
    const two = await image({ prompt: 'two foxes', n: 2, manager })

    expect(one.image.base64).toBe('AAEC')
    expect(two.images.map((file) => file.base64)).toEqual(['AwQF', 'BgcI'])
    ai.assertGeneratedImage((call) => call.prompt === 'a red fox')
    expect(ai.imageCalls()).toEqual([
      { prompt: 'a red fox', n: 1, provider: 'main' },
      { prompt: 'two foxes', n: 2, provider: 'main' },
    ])
    ai.assertNeverEmbedded()
  })

  it('should fail an unscripted image() once, naming the call', async () => {
    const ai = app.fakeAi()

    await expect(image({ prompt: 'x', manager: application.container.make('ai') }))
      .rejects.toThrow('image() was called, but nothing is scripted for it.')

    expect(() => ai[Symbol.dispose]()).toThrow(/respondImages/)
  })

  it('should refuse a TestApp built from a bare fetch function', () => {
    const bare = TestApp.fromFetch((request) => application.fetch(request))

    expect(() => bare.fakeAi()).toThrow('fromFetch()/fromWorkers() are handed a bare fetch function')
  })
})
