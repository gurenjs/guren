import { z } from 'zod'
import {
  AUTH_CONTEXT_KEY,
  AgentToolDenied,
  AgentToolInvoked,
  EventServiceProvider,
  MemoryQueueDriver,
  Worker,
  createQueueManager,
  createApp,
  createCsrfMiddleware,
  requireAuthenticated,
  type AgentApprovalMatch,
  type AgentApprovalRequest,
  type AgentApprovalStore,
  type Application,
  type AuthContext,
  type EventManager,
  type Router,
  type ServiceProviderConstructor,
} from '@guren/core'
import { MockEmbeddingModelV4, MockImageModelV4, MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'

import { AgentResponded, aiPlugin, defineAiConfig, type AiPluginConfig, type ConversationsConfig } from '../src'

export type ScriptedStep =
  | { text: string }
  | { toolCalls: Array<{ name: string; input: Record<string, unknown> }> }

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
}

/** A model that answers each generate or stream call with the next step of the script. */
export function scriptedModel(steps: ScriptedStep[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: steps.map((step, index) => ({ stream: convertArrayToReadableStream(streamParts(step, index)) })),
    doGenerate: steps.map((step, index) => ({
      content: 'text' in step
        ? [{ type: 'text' as const, text: step.text }]
        : step.toolCalls.map((call, callIndex) => ({
            type: 'tool-call' as const,
            toolCallId: `call-${index}-${callIndex}`,
            toolName: call.name,
            input: JSON.stringify(call.input),
          })),
      finishReason: { unified: 'text' in step ? ('stop' as const) : ('tool-calls' as const), raw: undefined },
      usage: USAGE,
      warnings: [],
    })),
  })
}

function streamParts(step: ScriptedStep, index: number) {
  const content = 'text' in step
    ? [
        { type: 'text-start' as const, id: `text-${index}` },
        { type: 'text-delta' as const, id: `text-${index}`, delta: step.text },
        { type: 'text-end' as const, id: `text-${index}` },
      ]
    : step.toolCalls.map((call, callIndex) => ({
        type: 'tool-call' as const,
        toolCallId: `call-${index}-${callIndex}`,
        toolName: call.name,
        input: JSON.stringify(call.input),
      }))
  return [
    { type: 'stream-start' as const, warnings: [] },
    ...content,
    {
      type: 'finish' as const,
      finishReason: { unified: 'text' in step ? ('stop' as const) : ('tool-calls' as const), raw: undefined },
      usage: USAGE,
    },
  ]
}

/** An array with a compare-and-set `consume`, as `@guren/plugin-agents`' tests use. */
export class MemoryApprovalStore implements AgentApprovalStore {
  readonly records: AgentApprovalRequest[] = []

  async create(request: AgentApprovalRequest): Promise<void> {
    this.records.push(request)
  }

  async find(id: string): Promise<AgentApprovalRequest | null> {
    return this.records.find((record) => record.id === id) ?? null
  }

  async findMatch(match: AgentApprovalMatch): Promise<AgentApprovalRequest | null> {
    const matched = this.records.filter(
      (record) =>
        record.tool === match.tool
        && record.fingerprint === match.fingerprint
        && record.principalKey === match.principalKey
        && record.consumedAt === undefined,
    )
    return matched.at(-1) ?? null
  }

  async consume(id: string): Promise<boolean> {
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record || record.consumedAt !== undefined) return false
    record.consumedAt = new Date().toISOString()
    return true
  }
}

function registerRoutes(router: Router): void {
  router.middleware(requireAuthenticated()).group((guarded) => {
    guarded
      .get('/me', async (c) => {
        const auth = c.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
        return Response.json({ user: (await auth?.user()) ?? null })
      })
      .name('echo_me')
      .agent({ description: 'Report the authenticated caller' })
  })

  router
    .get('/posts', () => Response.json({ posts: [{ id: 1 }] }))
    .name('posts.index')
    .agent({ description: 'List posts' })

  router
    .post('/posts', { body: z.object({ title: z.string(), secret: z.string().optional() }) }, ({ body }) =>
      Response.json({ created: body.title }))
    .name('posts.store')
    .agent({ description: 'Create a post', redact: ['secret'] })

  router
    .post('/posts/:id/publish', { params: z.object({ id: z.coerce.number() }) }, ({ params }) =>
      Response.json({ published: params.id }))
    .name('posts.publish')
    .agent({ description: 'Publish a post', approval: 'required' })

  router
    .delete('/posts/:id', { params: z.object({ id: z.coerce.number() }) }, () =>
      Response.json({ error: 'forbidden' }, { status: 403 }))
    .name('posts.destroy')
    .agent({ description: 'Delete a post' })
}

export interface Harness {
  app: Application
  records: Array<AgentToolInvoked | AgentToolDenied>
  /** Swap what the `default` provider answers with, per test. */
  script(steps: ScriptedStep[]): MockLanguageModelV4
  /** The `main` provider's embedding and image models; only `main` configures them. */
  embeddings: MockEmbeddingModelV4
  images: MockImageModelV4
}

export async function bootHarness(
  options: {
    plugin?: AiPluginConfig | false
    providers?: ServiceProviderConstructor[]
    /** Registered after `aiPlugin()`. */
    after?: ServiceProviderConstructor[]
    conversations?: ConversationsConfig
    routes?: (router: Router) => void
  } = {},
): Promise<Harness> {
  const current = scriptedModel([{ text: 'unscripted' }])
  const judge = scriptedModel([{ text: 'from the judge provider' }])
  const embeddings = new MockEmbeddingModelV4({
    modelId: 'mock-embeddings',
    maxEmbeddingsPerCall: Number.POSITIVE_INFINITY,
    doEmbed: async ({ values }) => ({ embeddings: values.map((_, index) => [index, 0.5]), warnings: [] }),
  })
  const images = new MockImageModelV4({
    modelId: 'mock-images',
    maxImagesPerCall: Number.MAX_SAFE_INTEGER,
    doGenerate: async ({ n }) => ({
      images: Array.from({ length: n }, (_, index) => `image-${index}`),
      warnings: [],
      response: { timestamp: new Date(0), modelId: 'mock-images', headers: undefined },
    }),
  })

  const app = createApp({
    routes: (router) => {
      registerRoutes(router)
      options.routes?.(router)
    },
    config: [
      defineAiConfig(() => ({
        default: 'main',
        providers: {
          main: { model: () => current, embeddingModel: () => embeddings, imageModel: () => images },
          judge: { model: () => judge },
        },
        ...(options.conversations ? { conversations: options.conversations } : {}),
      })),
    ],
    providers: [
      EventServiceProvider,
      ...(options.providers ?? []),
      ...(options.plugin === false ? [] : [aiPlugin(options.plugin ?? {})]),
      ...(options.after ?? []),
    ],
  })
  // Mounted before boot so every route sits behind it: an in-process call is
  // cookie-less, so without the seam a mutating tool would be refused 419.
  app.use('*', createCsrfMiddleware())
  await app.boot()

  const records: Harness['records'] = []
  const events = app.container.make<EventManager>('events')
  events.on(AgentToolInvoked, (event) => {
    records.push(event)
  })
  events.on(AgentToolDenied, (event) => {
    records.push(event)
  })

  return {
    app,
    records,
    embeddings,
    images,
    // The manager memoizes the model the factory returns, so the factory hands
    // back one object whose script is replaced in place.
    script(steps) {
      const next = scriptedModel(steps)
      current.doGenerate = next.doGenerate
      current.doGenerateCalls = next.doGenerateCalls
      current.doStream = next.doStream
      current.doStreamCalls = next.doStreamCalls
      return current
    },
  }
}

/** Let the event manager's fire-and-forget listeners run. */
export async function drainEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Binds a memory queue on the harness app; `work()` drains it through a real `Worker`. */
export function withQueue(h: Harness) {
  const driver = new MemoryQueueDriver()
  h.app.container.instance('queue', createQueueManager({ default: 'memory', drivers: { memory: () => driver } }))
  const responded: AgentResponded[] = []
  h.app.container.make<EventManager>('events').on(AgentResponded, (event) => {
    responded.push(event)
  })
  const failures: Error[] = []
  const work = () =>
    new Worker(driver, { container: h.app.container, stopWhenEmpty: true, sleep: 0 }, {
      jobFailed: (_job, error) => failures.push(error),
    }).start()
  return { driver, responded, failures, work }
}
