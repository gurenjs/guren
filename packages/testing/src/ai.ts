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
  AiManager,
  BoundAgent,
  BoundAgentFactory,
  bindAgent,
  resolveAgentName,
} from '@guren/plugin-ai'
import type { EmbeddingModel, LanguageModel, StepResult, ToolSet } from 'ai'
import type { MockLanguageModelV4 } from 'ai/test'

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
  /** Present when the tool threw. */
  error?: unknown
}

export interface FakeAiCall {
  input: string
  principal: AgentPrincipalInput
  /** Empty until the prompt settles, and for a prompt that failed before any step finished. */
  toolCalls: FakeAiRecordedToolCall[]
  response?: AgentResponse<unknown>
  error?: unknown
}

export interface FakeAiRuntime {
  bindAgent: typeof bindAgent
  resolveAgentName: typeof resolveAgentName
  MockLanguageModelV4: typeof MockLanguageModelV4
}

let runtimePromise: Promise<FakeAiRuntime> | undefined

/**
 * Rejects when `@guren/plugin-ai` or `ai` is not installed, or is a version without the
 * names used here: an optional peer can resolve to an older copy whose names are `undefined`.
 */
export function loadFakeAiRuntime(): Promise<FakeAiRuntime> {
  runtimePromise ??= (async () => {
    const [plugin, test] = await Promise.all([import('@guren/plugin-ai'), import('ai/test')])
    const runtime: Partial<FakeAiRuntime> = {
      bindAgent: plugin.bindAgent,
      resolveAgentName: plugin.resolveAgentName,
      MockLanguageModelV4: test.MockLanguageModelV4,
    }
    const missing = (Object.keys(runtime) as Array<keyof FakeAiRuntime>).filter((name) => typeof runtime[name] !== 'function')
    if (missing.length > 0) {
      throw new Error(
        `the installed @guren/plugin-ai or ai does not export ${missing.join(', ')}; `
        + 'upgrade @guren/plugin-ai to a release with fakeAi() support and ai to 7.x.',
      )
    }
    return runtime as FakeAiRuntime
  })()
  return runtimePromise
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
  private readonly restore: Disposable

  constructor(
    private readonly container: Container,
    private readonly runtime: FakeAiRuntime,
  ) {
    this.config = container.make<AiManager>('ai').config
    this.restore = container.fake('ai', this)
  }

  /** Queue one response per future prompt of `cls`, consumed in order. */
  respond(cls: AgentClass, responses: FakeAiResponse[]): this {
    const name = this.nameOf(cls)
    this.scripts.set(name, [...(this.scripts.get(name) ?? []), ...responses])
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
    return this.fail(
      `ai.embeddingModel(${provider === undefined ? '' : JSON.stringify(provider)}) was called, `
      + 'and fakeAi() scripts no embedding models.',
    )
  }

  /** Restores the real binding, then fails if any prompt found nothing scripted. */
  [Symbol.dispose](): void {
    this.restore[Symbol.dispose]()
    if (this.failures.length > 0) {
      throw new Error(`fakeAi() saw unscripted model calls:\n- ${this.failures.join('\n- ')}`)
    }
  }

  private recording<T extends Agent>(name: string, principal: AgentPrincipalInput, bound: BoundAgent<T>): BoundAgent<T> {
    return {
      agent: bound.agent,
      prompt: async (input, options) => {
        const call: FakeAiCall = { input, principal, toolCalls: [] }
        // Recorded on entry: a prompt that throws was still made.
        this.recorded.set(name, [...(this.recorded.get(name) ?? []), call])
        try {
          const response = await bound.prompt(input, options)
          call.response = response
          call.toolCalls = recordedToolCalls(response.steps)
          return response
        } catch (error) {
          call.error = error
          throw error
        }
      },
    }
  }

  private scriptedModel(name: string, provider: string | undefined): LanguageModel {
    const selected = provider ?? this.config.default
    if (!Object.hasOwn(this.config.providers, selected)) {
      return this.fail(
        `Agent [${name}] names the AI provider "${selected}", which config/ai.ts does not configure `
        + `(it configures: ${Object.keys(this.config.providers).join(', ') || '(none)'}).`,
      )
    }
    const response = this.scripts.get(name)?.shift()
    if (response === undefined) {
      return this.fail(
        `Agent [${name}] was prompted, but nothing is scripted for it. `
        + `Script it with ai.respond(${name}, [...]) before the prompt.`,
      )
    }

    const steps = flatten(response)
    let step = 0
    const mock = new this.runtime.MockLanguageModelV4({
      modelId: `fake:${name}`,
      doGenerate: async () => {
        const current = steps[step]
        if (current === undefined) {
          return this.fail(
            `Agent [${name}] asked the model for step ${step + 1}, but its scripted response has ${steps.length}. `
            + 'End the response with an answer (text or output) after the last toolCalls.',
          )
        }
        const index = step++
        return {
          content: 'toolCalls' in current
            ? current.toolCalls.map((toolCall, callIndex) => ({
                type: 'tool-call' as const,
                toolCallId: `fake-${index}-${callIndex}`,
                toolName: toolCall.name,
                input: JSON.stringify(toolCall.input ?? {}),
              }))
            : [{ type: 'text' as const, text: current.text }],
          finishReason: { unified: 'toolCalls' in current ? ('tool-calls' as const) : ('stop' as const), raw: undefined },
          usage: USAGE,
          warnings: [],
        }
      },
    })
    return mock
  }

  private fail(message: string): never {
    this.failures.push(message)
    throw new Error(message)
  }

  private failureSuffix(): string {
    return this.failures.length > 0 ? `\nUnscripted model calls:\n- ${this.failures.join('\n- ')}` : ''
  }

  private nameOf(cls: AgentClass): string {
    return this.runtime.resolveAgentName(cls)
  }
}

type FakeAiStep = { toolCalls: FakeAiToolCall[] } | { text: string }

function flatten(response: FakeAiResponse): FakeAiStep[] {
  if (typeof response === 'string') return [{ text: response }]
  if ('toolCalls' in response) return [{ toolCalls: response.toolCalls }, ...flatten(response.then)]
  if ('output' in response) return [{ text: JSON.stringify(response.output) }]
  return [{ text: response.text }]
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
