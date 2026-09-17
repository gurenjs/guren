// Set before anything imports @guren/core: the CSRF middleware needs a signing key.
process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Controller, createApp, createCsrfMiddleware, type Router } from '@guren/core'
import { Agent, Output, aiPlugin, defineAiConfig, stepCountIs, type AgentToolScope } from '@guren/plugin-ai'
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

  async unscripted() {
    const response = await this.make('ai').agent(NeverScripted).as(null).prompt('hello')
    return this.json({ text: response.text })
  }
}

function routes(router: Router): void {
  router.post('/summarize', [AiController, 'summarize'])
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
          },
        },
        conversations: { driver: 'memory' },
      })),
    ],
    providers: [aiPlugin()],
  })
  application.use('*', createCsrfMiddleware({ exclude: ['/summarize', '/unscripted'] }))
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
    expect(() => ai[Symbol.dispose]()).toThrow('fakeAi() found prompts its script did not answer')
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

  it('should refuse a TestApp built from a bare fetch function', () => {
    const bare = TestApp.fromFetch((request) => application.fetch(request))

    expect(() => bare.fakeAi()).toThrow('fromFetch()/fromWorkers() are handed a bare fetch function')
  })
})
