/**
 * `app.fakeAi()` (RFC 0029 §7). Replaces the `ai` binding so every model an agent
 * resolves is scripted, while its tools still run for real through `appTools()`
 * and the invocation pipeline. Type-only imports: `@guren/plugin-ai` and `ai` are
 * optional peers, loaded by {@link loadFakeAiRuntime} when an app binds `ai`.
 */
import type { Container } from '@guren/server'
import type {
  Agent,
  AgentClass,
  AgentPrincipalInput,
  AgentResponse,
  AiEvaluationModel,
  AiEvaluationQuestion,
  AiEvaluationQuestions,
  AiManager,
  AiProviderConfig,
  BoundAgent,
  BoundAgentFactory,
  ConversationStore,
  bindAgent,
  resolveAgentName,
} from '@guren/plugin-ai'
import type {
  EmbeddingModel,
  ImageModel,
  LanguageModel,
  StepResult,
  ToolSet,
  experimental_evaluate,
  simulateStreamingMiddleware,
  wrapLanguageModel,
} from 'ai'
import type { Experimental_EvaluationMockModelV4, MockEmbeddingModelV4, MockImageModelV4, MockLanguageModelV4 } from 'ai/test'

/** The model's final answer: plain text, or the value an agent's `output` schema parses. */
export type FakeAiAnswer = string | { text: string } | { output: unknown }

/** One scripted prompt: an answer, or tool calls the model requests before answering. */
export type FakeAiResponse = FakeAiAnswer | { toolCalls: FakeAiToolCall[]; then: FakeAiResponse }

export interface FakeAiToolCall {
  /** The tool's key in the agent's `tools()`. */
  name: string
  input?: Record<string, unknown>
}

/** A tool call the model made during a prompt, with what the real tool returned. */
export interface FakeAiRecordedToolCall {
  name: string
  input: unknown
  /** Present when the tool returned. */
  output?: unknown
  /** Present when the tool threw, or its input failed validation: the error for `prompt()`, its message for `stream()`. */
  error?: unknown
}

export interface FakeAiCall {
  input: string
  principal: AgentPrincipalInput
  /** Empty until the prompt settles (for `stream()`, until its body is read), and when no step finished. */
  toolCalls: FakeAiRecordedToolCall[]
  /** Set by `prompt()`; a `stream()` call answers with a `Response` instead. */
  response?: AgentResponse<unknown>
  error?: unknown
}

/** One value's vector. `respondEmbeddings` takes a queue of them, or a function answering every value. */
export type FakeAiEmbeddings = ReadonlyArray<readonly number[]> | ((value: string) => readonly number[])

/**
 * What one `image()` call answers with: one image, or the several an `n > 1` call
 * asks for. A string is base64, which the SDK decodes to sniff the media type.
 */
export type FakeAiImages = string | Uint8Array | readonly string[] | readonly Uint8Array[]

export interface FakeAiEmbedCall {
  /** One for `embed()`, the batch for `embedMany()`; empty when the fake refused the call. */
  values: string[]
  /** The provider name resolved for the call, the config's `default` included. */
  provider: string
}

export interface FakeAiImageCall {
  /** Absent when the call passed only input images, or when the fake refused it. */
  prompt?: string
  /** How many images were asked for; `0` when the fake refused the call. */
  n: number
  provider: string
}

export type FakeAiEvaluationAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number> }
  | { type: 'score'; score: number; probabilities?: Record<string, number> }
  | { type: 'boolean'; probability: number }

/**
 * One scripted evaluation, a value per question: a string is that choice at probability 1, a
 * number a boolean's probability or a score's position, an answer object passes through.
 * Checked against the questions when consumed, so a fake cannot answer what the real model could not.
 */
export type FakeAiEvaluation = Record<string, string | number | FakeAiEvaluationAnswer>

export interface FakeAiEvaluationCall {
  /** Absent when the fake refused the call before the SDK handed it the state (a provider with no `evaluationModel`). */
  state?: Parameters<typeof experimental_evaluate>[0]['state']
  questions: AiEvaluationQuestions
  /** The provider name resolved for the call, `defaultEvaluation` and `default` included. */
  provider: string
  answers?: Record<string, FakeAiEvaluationAnswer>
  error?: unknown
}

export interface FakeAiRuntime {
  bindAgent: typeof bindAgent
  resolveAgentName: typeof resolveAgentName
  MockLanguageModelV4: typeof MockLanguageModelV4
  MockEmbeddingModelV4: typeof MockEmbeddingModelV4
  MockImageModelV4: typeof MockImageModelV4
  EvaluationMockModelV4: typeof Experimental_EvaluationMockModelV4
  wrapLanguageModel: typeof wrapLanguageModel
  simulateStreamingMiddleware: typeof simulateStreamingMiddleware
}

let runtimePromise: Promise<FakeAiRuntime | Error> | undefined
let loadedRuntime: FakeAiRuntime | Error | undefined

/**
 * Import the optional peers once, so {@link createFakeAi} can stay synchronous. Settles to an
 * Error when either is missing or is a version without the names used here.
 */
export async function preloadFakeAiRuntime(): Promise<void> {
  runtimePromise ??= loadFakeAiRuntime().catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)))
  loadedRuntime = await runtimePromise
}

async function loadFakeAiRuntime(): Promise<FakeAiRuntime> {
  const [plugin, sdk, test] = await Promise.all([import('@guren/plugin-ai'), import('ai'), import('ai/test')])
  const runtime: Partial<FakeAiRuntime> = {
    bindAgent: plugin.bindAgent,
    resolveAgentName: plugin.resolveAgentName,
    MockLanguageModelV4: test.MockLanguageModelV4,
    MockEmbeddingModelV4: test.MockEmbeddingModelV4,
    MockImageModelV4: test.MockImageModelV4,
    EvaluationMockModelV4: test.Experimental_EvaluationMockModelV4,
    wrapLanguageModel: sdk.wrapLanguageModel,
    simulateStreamingMiddleware: sdk.simulateStreamingMiddleware,
  }
  // An optional peer can resolve to an older copy, whose missing names import as `undefined`.
  const missing = (Object.keys(runtime) as Array<keyof FakeAiRuntime>).filter((name) => typeof runtime[name] !== 'function')
  if (missing.length > 0) {
    throw new Error(
      `the installed @guren/plugin-ai or ai does not export ${missing.join(', ')}; `
      + 'upgrade @guren/plugin-ai to a release with fakeAi() support and ai to ^7.0.106.',
    )
  }
  return runtime as FakeAiRuntime
}

/** `TestApp.fakeAi()` once the TestApp knows its container. */
export function createFakeAi(container: Container): FakeAi {
  if (!container.has('ai')) {
    throw new Error(
      'This app binds no `ai` manager to fake. Add config/ai.ts (defineAiConfig from @guren/plugin-ai) '
      + 'to createApp({ config }).',
    )
  }
  if (!loadedRuntime || loadedRuntime instanceof Error) {
    throw new Error(
      'fakeAi() needs @guren/plugin-ai and ai installed, and could not import them'
      + (loadedRuntime ? `: ${loadedRuntime.message}` : '.'),
    )
  }
  return new FakeAi(container, loadedRuntime)
}

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
}

/**
 * The `ai` binding while faked. Scripts are keyed by agent wire name
 * (`resolveAgentName`), the identity audit lines and queued runs use.
 */
export class FakeAi implements AiManager, Disposable {
  readonly config: AiManager['config']
  private readonly scripts = new Map<string, FakeAiResponse[]>()
  private readonly recorded = new Map<string, FakeAiCall[]>()
  private readonly failures: string[] = []
  /** Consumed one vector per value; a function answers every value and is never exhausted. */
  private readonly embeddings: Array<readonly number[]> = []
  private embedder?: (value: string) => readonly number[]
  private readonly images: FakeAiImages[] = []
  private readonly embedRecords: FakeAiEmbedCall[] = []
  private readonly imageRecords: FakeAiImageCall[] = []
  private readonly evaluationScripts: FakeAiEvaluation[] = []
  private readonly evaluationRecords: FakeAiEvaluationCall[] = []
  /** One per scripted prompt, read on dispose: a loop `stopWhen` ended early never asks for the rest. */
  private readonly progress: Array<{ name: string; consumed: () => number; total: number }> = []
  private readonly restore: Disposable
  private readonly real: AiManager

  constructor(
    private readonly container: Container,
    private readonly runtime: FakeAiRuntime,
  ) {
    this.real = container.make<AiManager>('ai')
    this.config = this.real.config
    this.restore = container.fake('ai', this)
  }

  /** Queue one response per future prompt of `cls`, consumed in order. */
  respond(cls: AgentClass, responses: FakeAiResponse[]): this {
    listFor(this.scripts, this.nameOf(cls)).push(...responses)
    return this
  }

  calls(cls: AgentClass): readonly FakeAiCall[] {
    return this.recorded.get(this.nameOf(cls)) ?? []
  }

  assertPrompted(cls: AgentClass, predicate?: (input: string, call: FakeAiCall) => boolean): void {
    const name = this.nameOf(cls)
    const calls = this.calls(cls)
    if (calls.length === 0) {
      throw new Error(`Expected agent [${name}] to be prompted, but it was not.${this.failureSuffix()}`)
    }
    if (predicate && !calls.some((call) => predicate(call.input, call))) {
      throw new Error(
        `Expected agent [${name}] to be prompted with matching input. It was prompted with: `
        + `${calls.map((call) => JSON.stringify(call.input)).join(', ')}.${this.failureSuffix()}`,
      )
    }
  }

  /** No prompt of `cls` matches `predicate`; use {@link assertNeverPrompted} for none at all. */
  assertNotPrompted(cls: AgentClass, predicate: (input: string, call: FakeAiCall) => boolean): void {
    const match = this.calls(cls).find((call) => predicate(call.input, call))
    if (match) {
      throw new Error(`Unexpected prompt of agent [${this.nameOf(cls)}] with matching input: ${JSON.stringify(match.input)}.`)
    }
  }

  assertNeverPrompted(cls: AgentClass): void {
    const count = this.calls(cls).length
    if (count > 0) {
      throw new Error(`Expected agent [${this.nameOf(cls)}] never to be prompted, but it was prompted ${count} time(s).`)
    }
  }

  /**
   * Answer future `embed()` / `embedMany()` calls. An array is a queue drawn one
   * vector per *value*, so a script does not depend on how the SDK batches a
   * large `embedMany()`; a function answers every value instead.
   */
  respondEmbeddings(embeddings: FakeAiEmbeddings): this {
    if (typeof embeddings === 'function') this.embedder = embeddings
    else this.embeddings.push(...embeddings)
    return this
  }

  /** Queue one entry per future `image()` call, consumed in order. */
  respondImages(images: readonly FakeAiImages[]): this {
    this.images.push(...images)
    return this
  }

  embedCalls(): readonly FakeAiEmbedCall[] {
    return this.embedRecords
  }

  imageCalls(): readonly FakeAiImageCall[] {
    return this.imageRecords
  }

  assertEmbedded(predicate?: (call: FakeAiEmbedCall) => boolean): void {
    this.assertCalled(EMBED_CALLS, this.embedRecords, predicate)
  }

  assertNeverEmbedded(): void {
    this.assertNeverCalled(EMBED_CALLS, this.embedRecords)
  }

  assertGeneratedImage(predicate?: (call: FakeAiImageCall) => boolean): void {
    this.assertCalled(IMAGE_CALLS, this.imageRecords, predicate)
  }

  assertNeverGeneratedImage(): void {
    this.assertNeverCalled(IMAGE_CALLS, this.imageRecords)
  }

  /** Queue one answer set per future `evaluate()` call, consumed in order. */
  respondEvaluations(evaluations: readonly FakeAiEvaluation[]): this {
    this.evaluationScripts.push(...evaluations)
    return this
  }

  evaluationCalls(): readonly FakeAiEvaluationCall[] {
    return this.evaluationRecords
  }

  assertEvaluated(predicate?: (call: FakeAiEvaluationCall) => boolean): void {
    this.assertCalled(EVALUATION_CALLS, this.evaluationRecords, predicate)
  }

  assertNeverEvaluated(): void {
    this.assertNeverCalled(EVALUATION_CALLS, this.evaluationRecords)
  }

  agent<T extends Agent>(cls: AgentClass<T>): BoundAgentFactory<T> {
    const name = this.nameOf(cls)
    return {
      as: (principal) => {
        // A manager per agent, because `model()` is told the provider and never the class.
        const manager: AiManager = {
          config: this.config,
          agent: (other) => this.agent(other),
          model: (provider) => this.scriptedModel(name, provider),
          embeddingModel: (provider) => this.embeddingModel(provider),
          imageModel: (provider) => this.imageModel(provider),
          evaluationModel: (provider) => this.evaluationModel(provider),
          conversations: () => this.conversations(),
        }
        const bound = this.runtime.bindAgent(cls, principal, { container: this.container, manager })
        return this.recording(name, principal, bound)
      },
    }
  }

  model(provider?: string): LanguageModel {
    return this.fail(
      `ai.model(${provider === undefined ? '' : JSON.stringify(provider)}) was called outside an agent. `
      + 'fakeAi() scripts agents: prompt through ai.agent(Class).as(...) and script it with ai.respond(Class, [...]).',
    )
  }

  embeddingModel(provider?: string): EmbeddingModel {
    const record = this.recordCall(EMBED_CALLS, this.embedRecords, { values: [], provider: provider ?? this.config.default })
    if (this.embedder === undefined && this.embeddings.length === 0) this.fail(unscripted(EMBED_CALLS))
    return new this.runtime.MockEmbeddingModelV4({
      modelId: `fake:${record.provider}`,
      // Infinity is the SDK's "no limit": without it the mock's default of 1 splits
      // an embedMany() into one doEmbed per value.
      maxEmbeddingsPerCall: Number.POSITIVE_INFINITY,
      doEmbed: async ({ values }) => {
        record.values.push(...values)
        return { embeddings: values.map((value) => this.vectorFor(value)), warnings: [] }
      },
    })
  }

  imageModel(provider?: string): ImageModel {
    const record = this.recordCall(IMAGE_CALLS, this.imageRecords, { n: 0, provider: provider ?? this.config.default })
    const scripted = this.images.shift()
    if (scripted === undefined) this.fail(unscripted(IMAGE_CALLS))
    const images = scriptedImages(scripted)
    const modelId = `fake:${record.provider}`
    return new this.runtime.MockImageModelV4({
      modelId,
      // No limit of the model's own, so `n` alone never splits the call. A caller
      // passing generateImage's own maxImagesPerCall still can, which is why `n` sums.
      maxImagesPerCall: Number.MAX_SAFE_INTEGER,
      doGenerate: async ({ prompt, n }) => {
        record.n += n
        if (prompt !== undefined) record.prompt = prompt
        return {
          images,
          warnings: [],
          // A scripted empty array is the test's choice; the SDK would otherwise retry it.
          isRetryable: false,
          response: { timestamp: new Date(0), modelId, headers: undefined },
        }
      },
    })
  }

  evaluationModel(provider?: string): AiEvaluationModel {
    const selected = provider ?? this.config.defaultEvaluation ?? this.config.default
    // The state arrives only in doEvaluate, so a refused call is recorded without one.
    const record = this.recordCall(EVALUATION_CALLS, this.evaluationRecords, { questions: {}, provider: selected })
    return new this.runtime.EvaluationMockModelV4({
      provider: 'fake',
      modelId: `fake:${selected}`,
      supportedQuestionTypes: ['choice', 'score', 'boolean'],
      doEvaluate: async ({ state, questions }) => {
        record.state = state
        record.questions = questions
        try {
          const script = this.evaluationScripts.shift()
          if (script === undefined) throw new Error(unscripted(EVALUATION_CALLS, ` (state ${JSON.stringify(state).slice(0, 80)})`))
          record.answers = expandEvaluation(script, questions)
          return { answers: record.answers, warnings: [] }
        } catch (error) {
          record.error = error
          return this.fail(error instanceof Error ? error.message : String(error))
        }
      },
    })
  }

  /**
   * Recorded before anything can refuse the call, as a prompt is: a call the fake
   * rejected was still a call, and an assertion saying it never happened would lie.
   */
  private recordCall<C extends { provider: string }>(kind: ModelCallKind<C>, records: C[], record: C): C {
    records.push(record)
    this.checkProvider(kind.caller, kind.factory, record.provider)
    return record
  }

  private assertCalled<C>(kind: ModelCallKind<C>, records: readonly C[], predicate?: (call: C) => boolean): void {
    if (records.length === 0) {
      throw new Error(`Expected ${kind.caller} to be called, but it was not.${this.failureSuffix()}`)
    }
    if (predicate && !records.some((call) => predicate(call))) {
      throw new Error(
        `Expected ${kind.caller} to be called with ${kind.matching}. It was called with: `
        + `${records.map((call) => JSON.stringify(kind.describe(call))).join(', ')}.${this.failureSuffix()}`,
      )
    }
  }

  private assertNeverCalled<C>(kind: ModelCallKind<C>, records: readonly C[]): void {
    if (records.length > 0) {
      throw new Error(`Expected ${kind.never} ${records.length} time(s).`)
    }
  }

  private vectorFor(value: string): number[] {
    if (this.embedder) return [...this.embedder(value)]
    const next = this.embeddings.shift()
    if (next === undefined) {
      this.fail(
        `embed() or embedMany() asked for the embedding of ${JSON.stringify(value)}, and the script is exhausted. `
        + 'Script one vector per value with ai.respondEmbeddings([...]), or pass a function.',
      )
    }
    return [...next]
  }

  /** Refuse a provider name config/ai.ts does not configure; shared with the prompt path. */
  private checkConfigured(subject: string, selected: string): void {
    if (!Object.hasOwn(this.config.providers, selected)) {
      this.fail(
        `${subject} names the AI provider "${selected}", which config/ai.ts does not configure `
        + `(it configures: ${Object.keys(this.config.providers).join(', ') || '(none)'}).`,
      )
    }
  }

  private checkProvider(caller: string, kind: Exclude<keyof AiProviderConfig, 'pricing'>, selected: string): void {
    this.checkConfigured(caller, selected)
    // Checked, never called: the fake answers the call, but a provider with no factory
    // would throw outside the fake, and a test that passes there is measuring nothing.
    if (!this.config.providers[selected]?.[kind]) {
      this.fail(`${caller} resolves the AI provider "${selected}", which configures no ${kind} in config/ai.ts.`)
    }
  }

  /** The real manager's store: fakeAi() scripts the model, and conversations persist as configured. */
  conversations(): ConversationStore {
    return this.real.conversations()
  }

  /** Restores the binding, then fails on any prompt that found nothing scripted or left steps unused. */
  [Symbol.dispose](): void {
    this.restore[Symbol.dispose]()
    const unused = this.progress
      .filter((prompt) => prompt.consumed() < prompt.total)
      .map((prompt) =>
        `Agent [${prompt.name}] stopped after ${prompt.consumed()} of its ${prompt.total} scripted steps; `
        + 'the loop ended before the scripted answer (check the agent\'s stopWhen).')
    if (this.failures.length + unused.length > 0) {
      throw new Error(`fakeAi() found calls its script did not answer:${formatList([...this.failures, ...unused])}`)
    }
  }

  private recording<T extends Agent>(name: string, principal: AgentPrincipalInput, bound: BoundAgent<T>): BoundAgent<T> {
    const record = async <R>(input: string, run: (call: FakeAiCall) => Promise<R>): Promise<R> => {
      const call: FakeAiCall = { input, principal, toolCalls: [] }
      // Recorded on entry: a call that throws was still made.
      listFor(this.recorded, name).push(call)
      try {
        return await run(call)
      } catch (error) {
        call.error = error
        throw error
      }
    }
    return {
      agent: bound.agent,
      continue: (id) => this.recording(name, principal, bound.continue(id)),
      prompt: (input, options) => record(input, async (call) => {
        const response = await bound.prompt(input, options)
        call.response = response
        call.toolCalls = recordedToolCalls(response.steps)
        return response
      }),
      stream: (input, options) => record(input, async (call) => tapToolCalls(await bound.stream(input, options), call)),
      // Not recorded here: the worker's run comes back through agent() and records then.
      queue: (input, options) => bound.queue(input, options),
      broadcast: (input, channel, options) => bound.broadcast(input, channel, options),
    }
  }

  private scriptedModel(name: string, provider: string | undefined): LanguageModel {
    const selected = provider ?? this.config.default
    this.checkProvider(`Agent [${name}]`, 'model', selected)
    const response = this.scripts.get(name)?.shift()
    if (response === undefined) {
      return this.fail(
        `Agent [${name}] was prompted, but nothing is scripted for it. `
        + `Script it with ai.respond(${name}, [...]) before the prompt.`,
      )
    }

    const steps = flatten(response)
    let step = 0
    this.progress.push({ name, consumed: () => step, total: steps.length })
    const model = new this.runtime.MockLanguageModelV4({
      modelId: `fake:${name}`,
      doGenerate: async () => {
        const index = step++
        const current = steps[index]
        // Unreachable while `bindAgent` resolves a model per prompt; guards a memoized one.
        if (current === undefined) {
          return this.fail(`Agent [${name}] asked the model for step ${index + 1}, but its scripted response has ${steps.length}.`)
        }
        if ('text' in current) {
          return { content: [{ type: 'text', text: current.text }], finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [] }
        }
        return {
          content: current.toolCalls.map((toolCall, callIndex) => ({
            type: 'tool-call',
            toolCallId: `fake-${index}-${callIndex}`,
            toolName: toolCall.name,
            input: JSON.stringify(toolCall.input ?? {}),
          })),
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: USAGE,
          warnings: [],
        }
      },
    })
    // `stream()` reaches the same script: the middleware answers doStream from doGenerate.
    return this.runtime.wrapLanguageModel({ model, middleware: this.runtime.simulateStreamingMiddleware() })
  }

  private fail(message: string): never {
    this.failures.push(message)
    throw new Error(message)
  }

  private failureSuffix(): string {
    return this.failures.length > 0 ? `\nUnscripted model calls:${formatList(this.failures)}` : ''
  }

  private nameOf(cls: AgentClass): string {
    return this.runtime.resolveAgentName(cls)
  }
}

/** The wording one family of model calls contributes to the fake's failure messages. */
interface ModelCallKind<C> {
  caller: string
  factory: Exclude<keyof AiProviderConfig, 'pricing'>
  /** The `assertNever*` clause up to the count; embed's is plural, so it is not derived from `caller`. */
  never: string
  matching: string
  script: string
  describe: (call: C) => unknown
}

const EMBED_CALLS: ModelCallKind<FakeAiEmbedCall> = {
  caller: 'embed() or embedMany()',
  factory: 'embeddingModel',
  never: 'embed() and embedMany() never to be called, but they were called',
  matching: 'matching values',
  script: 'ai.respondEmbeddings([...])',
  describe: (call) => call.values,
}

const IMAGE_CALLS: ModelCallKind<FakeAiImageCall> = {
  caller: 'image()',
  factory: 'imageModel',
  never: 'image() never to be called, but it was called',
  matching: 'a matching prompt',
  script: 'ai.respondImages([...])',
  describe: (call) => call.prompt,
}

const EVALUATION_CALLS: ModelCallKind<FakeAiEvaluationCall> = {
  caller: 'evaluate()',
  factory: 'evaluationModel',
  never: 'evaluate() never to be called, but it was called',
  matching: 'a matching state',
  script: 'ai.respondEvaluations([{ ... }])',
  describe: (call) => call.state,
}

function unscripted(kind: ModelCallKind<never>, detail = ''): string {
  return `${kind.caller} was called${detail}, but nothing is scripted for it. Script it with ${kind.script} before the call.`
}

/** One script entry's images, keeping the homogeneous array the SDK's result type wants. */
function scriptedImages(scripted: FakeAiImages): string[] | Uint8Array[] {
  if (typeof scripted === 'string') return [scripted]
  if (scripted instanceof Uint8Array) return [scripted]
  return scripted.slice()
}

function oneHot(keys: readonly string[], hit: string): Record<string, number> {
  return Object.fromEntries(keys.map((key) => [key, key === hit ? 1 : 0]))
}

function expandAnswer(id: string, question: AiEvaluationQuestion, value: FakeAiEvaluation[string]): FakeAiEvaluationAnswer {
  if (typeof value === 'object') return value
  const given = `ai.respondEvaluations() gives question "${id}" ${JSON.stringify(value)}`
  switch (question.type) {
    case 'choice': {
      const options = Object.keys(question.criteria)
      if (typeof value !== 'string' || !options.includes(value)) throw new Error(`${given}, not one of its options: ${options.join(', ')}.`)
      return { type: 'choice', choice: value, probabilities: oneHot(options, value) }
    }
    case 'score': {
      const top = question.criteria.length - 1
      if (typeof value !== 'number' || value < 0 || value > top) throw new Error(`${given}; a score is a number from 0 to ${top}.`)
      const levels = question.criteria.map((_, index) => String(index))
      return { type: 'score', score: value, ...(Number.isInteger(value) ? { probabilities: oneHot(levels, String(value)) } : {}) }
    }
    case 'boolean': {
      if (typeof value !== 'number' || value < 0 || value > 1) throw new Error(`${given}; a boolean answer is a probability from 0 to 1.`)
      return { type: 'boolean', probability: value }
    }
  }
}

/** One answer per question. The SDK validates the result too; these messages name the script, which its would not. */
function expandEvaluation(script: FakeAiEvaluation, questions: AiEvaluationQuestions): Record<string, FakeAiEvaluationAnswer> {
  const unknown = Object.keys(script).filter((id) => !Object.hasOwn(questions, id))
  if (unknown.length > 0) {
    throw new Error(`ai.respondEvaluations() scripts ${unknown.map((id) => JSON.stringify(id)).join(', ')}, which the evaluation does not ask (it asks: ${Object.keys(questions).join(', ')}).`)
  }
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const value = script[id]
    if (value === undefined) throw new Error(`ai.respondEvaluations() scripts no value for question "${id}".`)
    return [id, expandAnswer(id, question, value)]
  }))
}

function listFor<T>(lists: Map<string, T[]>, key: string): T[] {
  let list = lists.get(key)
  if (!list) lists.set(key, (list = []))
  return list
}

function formatList(lines: readonly string[]): string {
  return lines.map((line) => `\n- ${line}`).join('')
}

type FakeAiStep = { toolCalls: FakeAiToolCall[] } | { text: string }

function flatten(response: FakeAiResponse): FakeAiStep[] {
  if (typeof response === 'string') return [{ text: response }]
  if ('toolCalls' in response) return [{ toolCalls: response.toolCalls }, ...flatten(response.then)]
  if ('output' in response) return [{ text: JSON.stringify(response.output) }]
  return [{ text: response.text }]
}

/** Fill `call.toolCalls` from the UI-message chunks as the body is read, passing every byte through. */
function tapToolCalls(response: Response, call: FakeAiCall): Response {
  if (!response.body) return response
  const decoder = new TextDecoder()
  const byId = new Map<string, FakeAiRecordedToolCall>()
  let pending = ''
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      controller.enqueue(bytes)
      pending += decoder.decode(bytes, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: {"type":"tool-')) continue
        const chunk = JSON.parse(line.slice('data: '.length)) as { type: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown; errorText?: string }
        if ((chunk.type === 'tool-input-available' || chunk.type === 'tool-input-error') && chunk.toolCallId) {
          const recorded: FakeAiRecordedToolCall = {
            name: chunk.toolName ?? '',
            input: chunk.input,
            ...(chunk.type === 'tool-input-error' ? { error: chunk.errorText } : {}),
          }
          byId.set(chunk.toolCallId, recorded)
          call.toolCalls.push(recorded)
        } else if (chunk.type === 'tool-output-available' && chunk.toolCallId) {
          const recorded = byId.get(chunk.toolCallId)
          if (recorded) recorded.output = chunk.output
        } else if (chunk.type === 'tool-output-error' && chunk.toolCallId) {
          const recorded = byId.get(chunk.toolCallId)
          if (recorded) recorded.error = chunk.errorText
        }
      }
    },
  })
  return new Response(response.body.pipeThrough(tap), response)
}

function recordedToolCalls(steps: ReadonlyArray<StepResult<ToolSet>>): FakeAiRecordedToolCall[] {
  return steps.flatMap((step) =>
    step.toolCalls.map((toolCall) => {
      const settled = step.content.find(
        (part) => (part.type === 'tool-result' || part.type === 'tool-error') && part.toolCallId === toolCall.toolCallId,
      )
      return {
        name: toolCall.toolName,
        input: toolCall.input,
        ...(settled?.type === 'tool-result' ? { output: settled.output } : {}),
        ...(settled?.type === 'tool-error' ? { error: settled.error } : {}),
      }
    }))
}
