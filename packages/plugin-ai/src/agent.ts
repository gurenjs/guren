/**
 * The `Agent` class (RFC 0029 §1): a class per agent over the AI SDK's
 * `ToolLoopAgent`, constructed by `as(principal)` so that `this.make()` and
 * `appTools()` resolve from the application and principal the call belongs to.
 */
import { type AgentPrincipal, type ServiceBindings } from '@guren/core'
import {
  ToolLoopAgent,
  stepCountIs,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type OutputInterface,
  type ProviderMetadata,
  type StepResult,
  type StopCondition,
  type Tool,
  type ToolLoopAgentSettings,
  type ToolSet,
} from 'ai'

import { ambientManager } from './ambient'
import { appToolDefinitions, appTools, type AppToolDefinition, type AppToolDenial, type AppToolError } from './app-tools'
import { readAgentContext, setAgentContext, type AgentContext } from './context'
import type { AiManager } from './manager'
import { CONVERSATION_HEADER } from './protocol'
import { RunAgentJob, registeredAgent } from './queue'
import { resolveRuntime } from './runtime'
import type { AgentToolInput, AgentToolName, AgentToolOutput, AgentToolScope, AiProviderName, Granted } from './types'

const ON_A_MANAGER = 'call ai.agent(Class).as(...) on a manager'

/** What `as()` accepts: a principal, or a user record contributing its `id` (and `abilities`, if it carries them). */
export type AgentPrincipalInput =
  | AgentPrincipal
  | { id: string | number; kind?: 'user' | 'service'; abilities?: readonly string[] }
  | null

export interface PromptOptions {
  /** A provider name from `config/ai.ts`, overriding the class's own for this call. */
  provider?: AiProviderName
  signal?: AbortSignal
  /**
   * `true` starts a conversation and returns its id; an id continues one, as `continue(id)` does.
   * Absent, nothing is stored. Refused under `as(null)`, since no owner could be checked.
   */
  conversation?: true | string
}

export interface QueueOptions {
  provider?: AiProviderName
  /** As {@link PromptOptions.conversation}; `true` creates the conversation now, so its id is usable before the run. */
  conversation?: true | string
  /** The queue name; `default` when absent. */
  queue?: string
  /** Milliseconds before a worker may run it. */
  delay?: number
}

export interface QueuedAgentRun {
  jobId: string
  /** Set when the run starts or continues a conversation. */
  conversationId?: string
}

/** One source a step cited or retrieved (a web search result, a citation), as the AI SDK reports it. */
export type AgentSource = StepResult<ToolSet>['sources'][number]

export interface AgentResponse<TOutput> {
  /** The final step's text; a continuation that resumes a paused step in one step adds to it (`continueWhen`). */
  text: string
  output: TOutput
  /** Every step, continuations included. */
  steps: Array<StepResult<ToolSet>>
  /** Summed over every step. */
  usage: LanguageModelUsage
  finishReason: FinishReason
  /** The provider's own reason, such as Anthropic's `pause_turn`, which the SDK reports as `stop`. */
  rawFinishReason?: string
  /** Every step's sources, in order. */
  sources: AgentSource[]
  /** The final step's provider metadata; each step's is on {@link steps}. */
  providerMetadata?: ProviderMetadata
  /** The model that answered the final step, as the provider reports it. */
  modelId: string
  /** Set when the prompt started or continued a conversation. */
  conversationId?: string
}

/**
 * The AI SDK call settings an agent sends with every model call: the output cap, sampling,
 * retries, headers, timeouts, tool choice and `providerOptions` (Anthropic's `effort` or
 * `cacheControl`, say). Model, instructions, tools, output and `stopWhen` stay the class's own.
 */
export type AgentCallSettings = Pick<
  ToolLoopAgentSettings<never, ToolSet>,
  | 'maxOutputTokens'
  | 'temperature'
  | 'topP'
  | 'topK'
  | 'presencePenalty'
  | 'frequencyPenalty'
  | 'stopSequences'
  | 'seed'
  | 'reasoning'
  | 'maxRetries'
  | 'headers'
  | 'timeout'
  | 'toolChoice'
  | 'providerOptions'
>

/** Whether `prompt()` resumes the turn whose last step this is, by calling the model again with it appended. */
export type ContinueCondition = (step: StepResult<ToolSet>) => boolean

/**
 * Anthropic's `pause_turn`: the server paused its own tool loop (web search, web fetch), and the
 * turn resumes when the paused response is sent back. Read from the raw finish reason, so no
 * provider package is imported.
 */
export const isPausedTurn: ContinueCondition = (step) => step.rawFinishReason === 'pause_turn'

/** The class's `output` member's parsed type, or `string` when it declares none. */
export type InferAgentOutput<T> = T extends { output: OutputInterface<infer O, unknown, unknown> } ? O : string

export interface BoundAgent<T extends Agent> {
  /** The constructed instance, principal and container already set. */
  readonly agent: T
  prompt(input: string, options?: PromptOptions): Promise<AgentResponse<InferAgentOutput<T>>>
  /**
   * `prompt()` as a UI-message stream `Response` for `useChat`, with the conversation id in the
   * `X-Guren-Conversation` header when the call starts or continues one (RFC 0029 §4).
   */
  stream(input: string, options?: PromptOptions): Promise<Response>
  /**
   * Run `prompt()` on a worker (RFC 0029 §6), which emits `AgentResponded` when the model answers.
   * The class must be registered with `aiPlugin({ agents })`. The principal travels as it is now,
   * abilities included: a run queued before a user loses an ability still runs with it.
   */
  queue(input: string, options?: QueueOptions): Promise<QueuedAgentRun>
  /**
   * `queue()`, streaming the run to broadcast `channel` instead: each UI-message chunk is published as
   * `AgentChunk`, and no `AgentResponded` is emitted, since the stream's `finish` chunk ends the run.
   * Anyone subscribed to `channel` reads the transcript; register it as a private channel.
   */
  broadcast(input: string, channel: string, options?: QueueOptions): Promise<QueuedAgentRun>
  /** The same agent, prompting within conversation `id`, which this principal must have started with this agent. */
  continue(id: string): BoundAgent<T>
}

/** What `appTools(names)` returns: each tool typed against its route contract, refusals included in the result. */
export type AppTools<N extends string> = {
  [K in N]: Tool<AgentToolInput<K>, AgentToolOutput<K> | AppToolDenial | AppToolError>
}

// oxlint-disable-next-line typescript/no-explicit-any -- any Agent subclass, whatever its scopes parameter
export interface AgentClass<T extends Agent<any> = Agent<any>> {
  new (): T
  readonly name: string
  readonly agentName?: string
  readonly scopes: readonly string[]
}

const DEFAULT_STOP_WHEN = 20
const DEFAULT_MAX_CONTINUATIONS = 5
export const ANONYMOUS_AGENT_NAME = 'anonymous'

let constructing: AgentContext | undefined

/**
 * Subclass and set `instructions`; optionally `provider`, `tools()`, `output` (read by
 * {@link InferAgentOutput}), `stopWhen`, `settings` and `continueWhen`. Constructed by `ai.agent(Class).as(principal)` or `Class.as(principal)`, never `new`.
 * `extends Agent<typeof X.scopes>` (scopes `as const`) makes an ungranted
 * `appTools()` name a compile error (RFC 0029 §11).
 */
export abstract class Agent<S extends readonly AgentToolScope[] = readonly AgentToolScope[]> {
  /**
   * The stable wire name (audit, fakes, queued runs). Defaults to the class name, which a
   * minifier that mangles identifiers rewrites; pin it before anything durable keys on it.
   */
  static agentName?: string
  /** What the model may reach through `appTools()`, in the RFC 0016 scope grammar. */
  static scopes: readonly AgentToolScope[] = []

  abstract instructions: string
  provider?: AiProviderName
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>
  settings?: AgentCallSettings
  /**
   * Checked against the last step once the tool loop ends: while it holds, `prompt()` (and so
   * `queue()`) calls the model again with the turn so far appended. `stopWhen` counts afresh on
   * each call. `stream()` and `broadcast()` do not continue.
   */
  continueWhen?: ContinueCondition
  /** How many times `continueWhen` may continue one prompt; 5 when absent. */
  maxContinuations?: number

  constructor() {
    const context = constructing
    constructing = undefined
    if (!context) {
      throw new Error(
        `${new.target.name} is constructed by as(principal): ai.agent(${new.target.name}).as(user), `
        + `or ${new.target.name}.as(user). A bare \`new\` has no application or principal to act for.`,
      )
    }
    setAgentContext(this, context)
  }

  /** Runs once per bound instance, after the principal is known. */
  tools(): ToolSet {
    return {}
  }

  protected make<K extends keyof ServiceBindings>(key: K): ServiceBindings[K]
  protected make<T>(key: string): T
  protected make(key: string): unknown {
    return readAgentContext(this).container.make(key)
  }

  /** The application's own agent tools, gated by the invocation pipeline (RFC 0029 §2). */
  protected appTools<const N extends readonly AgentToolName[]>(names: N & Granted<S, N>): AppTools<N[number]> {
    return appTools(this, names) as AppTools<N[number]>
  }

  /** {@link appTools} before packaging as AI SDK tools, for another agent runtime to wrap. */
  protected appToolDefinitions(names: readonly AgentToolName[]): AppToolDefinition[] {
    return appToolDefinitions(this, names)
  }

  /** Who this instance acts as; `null` for an anonymous run. */
  get principal(): AgentPrincipal | null {
    return readAgentContext(this).principal
  }

  /** Bind to the default application's `ai` manager (RFC 0023 §3). */
  static as<T extends Agent>(this: AgentClass<T>, principal: AgentPrincipalInput): BoundAgent<T> {
    return ambientManager(`${this.name}.as()`, ON_A_MANAGER).agent(this).as(principal)
  }

  /** `as(null).prompt(...)`: an anonymous, read-only run. */
  static prompt<T extends Agent>(
    this: AgentClass<T>,
    input: string,
    options?: PromptOptions,
  ): Promise<AgentResponse<InferAgentOutput<T>>> {
    return ambientManager(`${this.name}.prompt()`, ON_A_MANAGER).agent(this).as(null).prompt(input, options)
  }
}

export interface AnonymousAgentOptions {
  instructions: string
  agentName?: string
  scopes?: readonly AgentToolScope[]
  provider?: AiProviderName
  tools?: (agent: Agent) => ToolSet
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>
  settings?: AgentCallSettings
  continueWhen?: ContinueCondition
  maxContinuations?: number
}

/** An anonymous subclass for a one-off call. Give it an `output` by subclassing instead. */
export function agent(options: AnonymousAgentOptions): AgentClass {
  return class AnonymousAgent extends Agent {
    static override agentName = options.agentName ?? ANONYMOUS_AGENT_NAME
    static override scopes = options.scopes ?? []
    instructions = options.instructions
    override provider = options.provider
    override stopWhen = options.stopWhen
    override settings = options.settings
    override continueWhen = options.continueWhen
    override maxContinuations = options.maxContinuations

    override tools(): ToolSet {
      return options.tools ? options.tools(this) : {}
    }
  }
}

/**
 * Only an *own* `agentName` counts, as with `resolveJobName`: statics are inherited, and
 * reading the prototype chain would give every subclass its parent's identity.
 */
export function resolveAgentName(cls: Pick<AgentClass, 'name' | 'agentName'>): string {
  const own = Object.prototype.hasOwnProperty.call(cls, 'agentName') ? cls.agentName : undefined
  return own ?? cls.name
}

/**
 * `AiManager.agent().as()`: construct `cls` for `principal`, resolving its model through
 * `scope.manager`. Public so another manager (a test fake) binds agents the same way.
 */
export function bindAgent<T extends Agent>(
  cls: AgentClass<T>,
  input: AgentPrincipalInput,
  scope: { container: AgentContext['container']; manager: AiManager },
): BoundAgent<T> {
  const principal = normalizePrincipal(input)
  constructing = { container: scope.container, principal, cls }
  let instance: T
  try {
    instance = new cls()
  } finally {
    constructing = undefined
  }
  // Called here, not per prompt: a misconfigured `appTools()` fails at `as()`,
  // the construction error RFC 0029 §2.2 asks for, before any model is called.
  const tools = instance.tools()

  const agentName = resolveAgentName(cls)
  const output = (instance as { output?: OutputInterface }).output
  if (output && instance.continueWhen) {
    // The SDK parses the output at the end of every call, so a paused call throws before continueWhen sees it.
    throw new Error(
      `${agentName} declares both an output schema and continueWhen, and a paused call fails to parse before it can `
      + 'be resumed. Let one agent research in text with continueWhen, and a second turn its answer into the schema.',
    )
  }

  const requestedConversation = (requested: true | string | undefined, conversation: string | undefined) => {
    if (conversation !== undefined && requested !== undefined && requested !== conversation) {
      throw new Error(
        `${agentName} is bound to conversation "${conversation}" by continue(), and this call asks for `
        + `${requested === true ? 'a new one' : `"${requested}"`}. Pass one or the other.`,
      )
    }
    return requested ?? conversation
  }

  const run = async (input: string, options: PromptOptions, conversation: string | undefined) => {
    // Settled before `model()`: a refused conversation must reach no model, and a fake's script.
    const history = await openConversation(requestedConversation(options.conversation, conversation))
    const userMessage: ModelMessage = { role: 'user', content: input }
    const loop = new ToolLoopAgent({
      // First, so the class's own model, instructions and tools win over a stray key.
      ...instance.settings,
      id: agentName,
      model: scope.manager.model(options.provider ?? instance.provider),
      instructions: instance.instructions,
      tools,
      ...(output ? { output } : {}),
      stopWhen: instance.stopWhen ?? stepCountIs(DEFAULT_STOP_WHEN),
    })
    const abort = options.signal ? { abortSignal: options.signal } : {}
    const call = {
      ...(history ? { messages: [...history.messages, userMessage] } : { prompt: input }),
      ...abort,
    }
    // A trailing assistant message, with no new user message, is how a paused turn resumes.
    const continueCall = (responseMessages: readonly ModelMessage[]) => ({
      messages: [...(history?.messages ?? []), userMessage, ...responseMessages],
      ...abort,
    })
    // Only once the model has answered: a failed or aborted turn stores nothing, and a new conversation no row.
    const persistTurn = async (responseMessages: readonly ModelMessage[]) => {
      if (!history) return
      const turn = [userMessage, ...responseMessages]
      if (history.isNew) {
        await history.store.create({ id: history.id, agentName, owner: history.owner, messages: turn })
      } else {
        await history.store.append(history.id, history.owner, turn)
      }
    }
    return { history, loop, call, continueCall, persistTurn }
  }

  const bound = (conversation: string | undefined): BoundAgent<T> => ({
    agent: instance,
    continue: (id) => bound(id),
    prompt: async (input, options = {}) => {
      const { history, loop, call, continueCall, persistTurn } = await run(input, options, conversation)
      const rounds = [await loop.generate(call)]
      const responseMessages = [...rounds[0]!.responseMessages]
      const maxContinuations = instance.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS
      while (
        instance.continueWhen
        && rounds.length <= maxContinuations
        && instance.continueWhen(rounds.at(-1)!.steps.at(-1) as StepResult<ToolSet>)
      ) {
        // Aborted between calls, the turn fails as one aborted mid-call does, storing nothing.
        options.signal?.throwIfAborted()
        const next = await loop.generate(continueCall(responseMessages))
        rounds.push(next)
        responseMessages.push(...next.responseMessages)
      }
      await persistTurn(responseMessages)
      const last = rounds.at(-1)!
      const lastStep = last.steps.at(-1)!
      return {
        text: stitchedText(rounds),
        output: (output ? last.output : stitchedText(rounds)) as InferAgentOutput<T>,
        steps: rounds.flatMap((round) => round.steps) as Array<StepResult<ToolSet>>,
        usage: rounds.length === 1 ? last.usage : rounds.map((round) => round.usage).reduce(addLanguageModelUsage),
        finishReason: last.finishReason,
        ...(last.rawFinishReason !== undefined ? { rawFinishReason: last.rawFinishReason } : {}),
        sources: rounds.flatMap((round) => round.sources),
        ...(lastStep.providerMetadata ? { providerMetadata: lastStep.providerMetadata } : {}),
        modelId: lastStep.response.modelId,
        ...(history ? { conversationId: history.id } : {}),
      }
    },
    stream: async (input, options = {}) => {
      refuseStreamingOutput('stream()')
      const { history, loop, call, persistTurn } = await run(input, options, conversation)
      const result = await loop.stream({
        ...call,
        onEnd: async (event) => {
          // The SDK still ends a stream aborted after a finished step, with that partial turn.
          if (options.signal?.aborted) return
          // The response has already started, so a storage failure has no status to set; the body waits for this.
          try {
            await persistTurn(event.responseMessages)
          } catch (error) {
            console.error(`[@guren/plugin-ai] ${agentName} could not store its turn in conversation "${history?.id}".`, error)
          }
        },
      })
      return result.toUIMessageStreamResponse(history ? { headers: { [CONVERSATION_HEADER]: history.id } } : {})
    },
    queue: (input, options = {}) => enqueue(input, options, conversation),
    broadcast: async (input, channel, options = {}) => {
      refuseStreamingOutput('broadcast()')
      if (!scope.container.has('broadcast')) {
        throw new Error(`${agentName}.broadcast() publishes through the \`broadcast\` binding, and none is bound. Register BroadcastServiceProvider.`)
      }
      return enqueue(input, options, conversation, channel)
    },
  })

  const enqueue = async (
    input: string,
    options: QueueOptions,
    conversation: string | undefined,
    channel?: string,
  ): Promise<QueuedAgentRun> => {
    const caller = `${agentName}.${channel === undefined ? 'queue' : 'broadcast'}()`
    if (registeredAgent(resolveRuntime(scope.container, caller), agentName) !== cls) {
      throw new Error(
        `aiPlugin({ agents }) registers a different class under "${agentName}" than ${cls.name}, `
        + 'so a worker would run that one. Give each agent its own static agentName.',
      )
    }
    if (!scope.container.has('queue')) {
      throw new Error(`${caller} dispatches through the \`queue\` binding, and none is bound. Register QueueServiceProvider.`)
    }
    // The worker checks again; this fails a run that could never succeed here, rather than in its log.
    const history = await openConversation(requestedConversation(options.conversation, conversation))
    // Created before dispatch: the id is usable at once, and a redelivered run only appends.
    if (history?.isNew) {
      await history.store.create({ id: history.id, agentName, owner: history.owner, messages: [] })
    }
    const jobId = await scope.container.make('queue').dispatch(
      RunAgentJob,
      { agentName, input, principal: instance.principal, conversationId: history?.id, provider: options.provider, channel },
      { queue: options.queue, delay: options.delay },
    )
    return { jobId, ...(history ? { conversationId: history.id } : {}) }
  }

  const refuseStreamingOutput = (caller: string) => {
    if (output) {
      throw new Error(
        `${agentName} declares an output schema, which ${caller} would send to the client as raw JSON text. `
        + 'Call prompt() for its parsed output.',
      )
    }
  }

  const openConversation = async (requested: true | string | undefined) => {
    if (requested === undefined) return undefined
    const owner = instance.principal
    if (!owner) {
      throw new Error(
        `${agentName} was asked for a conversation under as(null). A conversation belongs to the principal `
        + 'that started it, and an anonymous run has none to check: bind a user or service with as(principal).',
      )
    }
    if (agentName === ANONYMOUS_AGENT_NAME) {
      throw new Error(
        'A conversation is checked against the agent that started it, and every agent() without an agentName '
        + `is named "${ANONYMOUS_AGENT_NAME}". Pass agent({ agentName }) to keep conversations with it.`,
      )
    }
    const store = scope.manager.conversations()
    if (requested === true) return { store, owner, id: crypto.randomUUID(), isNew: true, messages: [] as ModelMessage[] }
    const stored = await store.load(requested, owner)
    if (!stored) {
      throw new Error(`${agentName} cannot continue conversation "${requested}": no conversation with that id belongs to this principal.`)
    }
    if (stored.agentName !== agentName) {
      throw new Error(
        `${agentName} cannot continue conversation "${requested}", which ${stored.agentName} started. `
        + 'Continue it with that agent, or start a new one.',
      )
    }
    return { store, owner, id: requested, isNew: false, messages: stored.messages }
  }

  return bound(undefined)
}

/**
 * The SDK's `text` is the final step's. A continuation's first step resumes the paused step, so
 * a round answering in that one step adds to the text; one that went on to call tools starts afresh.
 */
function stitchedText(rounds: ReadonlyArray<{ text: string; steps: readonly unknown[] }>): string {
  let text = ''
  rounds.forEach((round, index) => {
    text = index > 0 && round.steps.length === 1 ? text + round.text : round.text
  })
  return text
}

/** `raw` is the provider's own per-call usage, which does not sum, so it is left out. */
function addLanguageModelUsage(left: LanguageModelUsage, right: LanguageModelUsage): LanguageModelUsage {
  const add = (a: number | undefined, b: number | undefined) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0))
  return {
    inputTokens: add(left.inputTokens, right.inputTokens),
    inputTokenDetails: {
      noCacheTokens: add(left.inputTokenDetails.noCacheTokens, right.inputTokenDetails.noCacheTokens),
      cacheReadTokens: add(left.inputTokenDetails.cacheReadTokens, right.inputTokenDetails.cacheReadTokens),
      cacheWriteTokens: add(left.inputTokenDetails.cacheWriteTokens, right.inputTokenDetails.cacheWriteTokens),
    },
    outputTokens: add(left.outputTokens, right.outputTokens),
    outputTokenDetails: {
      textTokens: add(left.outputTokenDetails.textTokens, right.outputTokenDetails.textTokens),
      reasoningTokens: add(left.outputTokenDetails.reasoningTokens, right.outputTokenDetails.reasoningTokens),
    },
    totalTokens: add(left.totalTokens, right.totalTokens),
  }
}

function normalizePrincipal(input: AgentPrincipalInput): AgentPrincipal | null {
  if (input === null) return null
  const id: unknown = input.id
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new Error('as(principal) needs a principal with a string or number `id`, or null for an anonymous run.')
  }
  // Only these fields cross the seam: the route rebuilds the user through the
  // configured user provider, so anything else on a user record never reaches it.
  const kind = input.kind === 'service' ? 'service' : 'user'
  return {
    kind,
    id,
    ...(Array.isArray(input.abilities) ? { abilities: [...input.abilities] } : {}),
  }
}

