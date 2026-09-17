/**
 * The `Agent` class (RFC 0029 §1): a class per agent over the AI SDK's
 * `ToolLoopAgent`, constructed by `as(principal)` so that `this.make()` and
 * `appTools()` resolve from the application and principal the call belongs to.
 */
import { ambientContainer, type AgentPrincipal, type ServiceBindings } from '@guren/core'
import {
  ToolLoopAgent,
  stepCountIs,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type OutputInterface,
  type StepResult,
  type StopCondition,
  type Tool,
  type ToolSet,
} from 'ai'

import { appToolDefinitions, appTools, type AppToolDefinition, type AppToolDenial, type AppToolError } from './app-tools'
import { readAgentContext, setAgentContext, type AgentContext } from './context'
import type { AiManager } from './manager'
import type { AgentToolInput, AgentToolName, AgentToolOutput, AgentToolScope, AiProviderName, Granted } from './types'

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

export interface AgentResponse<TOutput> {
  text: string
  output: TOutput
  steps: Array<StepResult<ToolSet>>
  /** Summed over every step. */
  usage: LanguageModelUsage
  finishReason: FinishReason
  /** Set when the prompt started or continued a conversation. */
  conversationId?: string
}

/** The class's `output` member's parsed type, or `string` when it declares none. */
export type InferAgentOutput<T> = T extends { output: OutputInterface<infer O, unknown, unknown> } ? O : string

export interface BoundAgent<T extends Agent> {
  /** The constructed instance, principal and container already set. */
  readonly agent: T
  prompt(input: string, options?: PromptOptions): Promise<AgentResponse<InferAgentOutput<T>>>
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
const ANONYMOUS_AGENT_NAME = 'anonymous'

let constructing: AgentContext | undefined

/**
 * Subclass and set `instructions`; optionally `provider`, `tools()`, `output`
 * (an `Output.object(...)`, read by {@link InferAgentOutput}) and `stopWhen`.
 * Constructed by `ai.agent(Class).as(principal)` or `Class.as(principal)`, never `new`.
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
    return ambientManager(this.name).agent(this).as(principal)
  }

  /** `as(null).prompt(...)`: an anonymous, read-only run. */
  static prompt<T extends Agent>(
    this: AgentClass<T>,
    input: string,
    options?: PromptOptions,
  ): Promise<AgentResponse<InferAgentOutput<T>>> {
    return ambientManager(this.name).agent(this).as(null).prompt(input, options)
  }
}

export interface AnonymousAgentOptions {
  instructions: string
  agentName?: string
  scopes?: readonly AgentToolScope[]
  provider?: AiProviderName
  tools?: (agent: Agent) => ToolSet
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>
}

/** An anonymous subclass for a one-off call. Give it an `output` by subclassing instead. */
export function agent(options: AnonymousAgentOptions): AgentClass {
  return class AnonymousAgent extends Agent {
    static override agentName = options.agentName ?? ANONYMOUS_AGENT_NAME
    static override scopes = options.scopes ?? []
    instructions = options.instructions
    override provider = options.provider
    override stopWhen = options.stopWhen

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

  const bound = (conversation: string | undefined): BoundAgent<T> => ({
    agent: instance,
    continue: (id) => bound(id),
    prompt: async (input, options = {}) => {
      if (conversation !== undefined && options.conversation !== undefined && options.conversation !== conversation) {
        throw new Error(
          `${agentName} is bound to conversation "${conversation}" by continue(), and this prompt asks for `
          + `${options.conversation === true ? 'a new one' : `"${options.conversation}"`}. Pass one or the other.`,
        )
      }
      // Settled before `model()`: a refused conversation must reach no model, and a fake's script.
      const history = await openConversation(options.conversation ?? conversation)
      const userMessage: ModelMessage = { role: 'user', content: input }

      const output = (instance as { output?: OutputInterface }).output
      const loop = new ToolLoopAgent({
        id: agentName,
        model: scope.manager.model(options.provider ?? instance.provider),
        instructions: instance.instructions,
        tools,
        ...(output ? { output } : {}),
        stopWhen: instance.stopWhen ?? stepCountIs(DEFAULT_STOP_WHEN),
      })
      const result = await loop.generate({
        ...(history ? { messages: [...history.messages, userMessage] } : { prompt: input }),
        ...(options.signal ? { abortSignal: options.signal } : {}),
      })

      let conversationId: string | undefined
      if (history) {
        const turn = [userMessage, ...result.responseMessages]
        // Created only once the model has answered, so a failed first prompt leaves no empty conversation.
        if (history.id === undefined) {
          conversationId = await history.store.create({ agentName, owner: history.owner, messages: turn })
        } else {
          conversationId = history.id
          await history.store.append(conversationId, history.owner, turn)
        }
      }
      return {
        text: result.text,
        output: (output ? result.output : result.text) as InferAgentOutput<T>,
        steps: result.steps as Array<StepResult<ToolSet>>,
        usage: result.usage,
        finishReason: result.finishReason,
        ...(conversationId ? { conversationId } : {}),
      }
    },
  })

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
    if (requested === true) return { store, owner, id: undefined, messages: [] as ModelMessage[] }
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
    return { store, owner, id: requested, messages: stored.messages }
  }

  return bound(undefined)
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

function ambientManager(className: string): AiManager {
  const container = ambientContainer()
  if (!container?.has('ai')) {
    throw new Error(
      `${className}.as() resolves the \`ai\` manager from the default application, and none is bound. `
      + 'Add config/ai.ts (defineAiConfig) to createApp({ config }), or call ai.agent(Class).as(...) on a manager.',
    )
  }
  return container.make('ai')
}
