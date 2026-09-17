/**
 * Queued agent runs (RFC 0029 §6): `queue()` dispatches {@link RunAgentJob}, and the worker
 * prompts the agent and emits {@link AgentResponded}, since a closure cannot cross to a worker.
 */
import { Event, Job, type AgentPrincipal } from '@guren/core'
import type { FinishReason, LanguageModelUsage } from 'ai'

import type { AgentClass, PromptOptions } from './agent'
import type { AiManager } from './manager'
import { AI_RUNTIME_BINDING, type AiRuntime } from './runtime'
import type { AiProviderName } from './types'

/** Makes a `conversation: true` prompt create the id `queue()` already returned, rather than mint one. */
export const START_CONVERSATION = Symbol('guren.ai.startConversation')

export interface QueuedPromptOptions extends PromptOptions {
  [START_CONVERSATION]?: string
}

export interface RunAgentPayload {
  agentName: string
  input: string
  principal: AgentPrincipal | null
  conversationId?: string
  /** `conversationId` was minted by `queue({ conversation: true })`, and this run creates it. */
  startsConversation?: true
  provider?: AiProviderName
}

/** What `AgentResponded` carries: the response without `steps`, which a queued listener would serialize whole. */
export interface QueuedAgentResponse {
  text: string
  output: unknown
  usage: LanguageModelUsage
  finishReason: FinishReason
}

export class AgentResponded extends Event {
  static override eventName = 'AgentResponded'

  constructor(
    readonly agentName: string,
    readonly principal: AgentPrincipal | null,
    readonly conversationId: string | undefined,
    readonly response: QueuedAgentResponse,
  ) {
    super()
  }
}

export class RunAgentJob extends Job<RunAgentPayload> {
  static override jobName = 'RunAgentJob'
  // A retry would call the model again and re-run every tool the first attempt already ran.
  static override maxAttempts = 1

  async handle(payload: RunAgentPayload): Promise<void> {
    const cls = registeredAgent(this.make<AiRuntime>(AI_RUNTIME_BINDING), payload.agentName)
    const options: QueuedPromptOptions = {
      ...(payload.provider ? { provider: payload.provider } : {}),
      ...(payload.conversationId
        ? payload.startsConversation
          ? { conversation: true, [START_CONVERSATION]: payload.conversationId }
          : { conversation: payload.conversationId }
        : {}),
    }
    const response = await this.make<AiManager>('ai').agent(cls).as(payload.principal).prompt(payload.input, options)
    const { text, output, usage, finishReason, conversationId } = response
    await this.makeOptional('events')?.emit(
      new AgentResponded(payload.agentName, payload.principal, conversationId, { text, output, usage, finishReason }),
    )
  }
}

export function registeredAgent(runtime: AiRuntime, name: string): AgentClass {
  const cls = runtime.agents.get(name)
  if (!cls) {
    const names = [...runtime.agents.keys()]
    throw new Error(
      `No agent named "${name}" is registered. A queued run resolves its class through aiPlugin({ agents }), `
      + `which registers: ${names.length > 0 ? names.join(', ') : '(none)'}.`,
    )
  }
  return cls
}
