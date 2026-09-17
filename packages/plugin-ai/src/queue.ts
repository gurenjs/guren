/**
 * Queued agent runs (RFC 0029 §6): `queue()` dispatches {@link RunAgentJob}, and the worker
 * prompts the agent and emits {@link AgentResponded}, since a closure cannot cross to a worker.
 */
import { Event, Job, type AgentPrincipal } from '@guren/core'

import type { AgentClass, AgentResponse } from './agent'
import { describeNames } from './config'
import type { AiManager } from './manager'
import { AI_RUNTIME_BINDING, missingRuntime, type AiRuntime } from './runtime'
import type { AiProviderName } from './types'

export interface RunAgentPayload {
  agentName: string
  input: string
  principal: AgentPrincipal | null
  /** Created by `queue()` when the run starts one, so the worker always continues it. */
  conversationId?: string
  provider?: AiProviderName
}

/** What `AgentResponded` carries: the response without `steps`, which a queued listener would serialize whole. */
export type QueuedAgentResponse = Omit<AgentResponse<unknown>, 'steps' | 'conversationId'>

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
  // Stops only the worker's own retry: a driver whose visibility timeout ends before the run
  // (Redis, SQS) still delivers it again, model call and tools included.
  static override maxAttempts = 1

  async handle(payload: RunAgentPayload): Promise<void> {
    const runtime = this.makeOptional<AiRuntime>(AI_RUNTIME_BINDING)
    if (!runtime) throw missingRuntime('RunAgentJob')
    const cls = registeredAgent(runtime, payload.agentName)
    const response = await this.make<AiManager>('ai').agent(cls).as(payload.principal).prompt(payload.input, {
      provider: payload.provider,
      conversation: payload.conversationId,
    })
    const { text, output, usage, finishReason, conversationId } = response
    await this.makeOptional('events')?.emit(
      new AgentResponded(payload.agentName, payload.principal, conversationId, { text, output, usage, finishReason }),
    )
  }
}

export function registeredAgent(runtime: AiRuntime, name: string): AgentClass {
  const cls = runtime.agents.get(name)
  if (!cls) {
    throw new Error(
      `No agent named "${name}" is registered. A queued run resolves its class through aiPlugin({ agents }), `
      + `which registers: ${describeNames([...runtime.agents.keys()])}.`,
    )
  }
  return cls
}
