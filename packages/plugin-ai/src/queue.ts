/**
 * Queued agent runs (RFC 0029 §6): `queue()` dispatches {@link RunAgentJob}, and the worker
 * prompts the agent and emits {@link AgentResponded}, since a closure cannot cross to a worker.
 */
import { Event, Job, type AgentPrincipal, type BroadcastManager } from '@guren/core'
import { parseJsonEventStream, uiMessageChunkSchema, type UIMessageChunk } from 'ai'

import type { AgentClass, AgentResponse } from './agent'
import { describeNames } from './config'
import type { AiManager } from './manager'
import { AGENT_CHUNK_EVENT } from './protocol'
import { AI_RUNTIME_BINDING, missingRuntime, type AiRuntime } from './runtime'
import type { AiProviderName } from './types'

export interface RunAgentPayload {
  agentName: string
  input: string
  principal: AgentPrincipal | null
  /** Created by `queue()` when the run starts one, so the worker always continues it. */
  conversationId?: string
  provider?: AiProviderName
  /** Set by `broadcast()`: the run streams to this channel rather than emitting `AgentResponded`. */
  channel?: string
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
    const bind = () => {
      const runtime = this.makeOptional<AiRuntime>(AI_RUNTIME_BINDING)
      if (!runtime) throw missingRuntime('RunAgentJob')
      return this.make<AiManager>('ai').agent(registeredAgent(runtime, payload.agentName)).as(payload.principal)
    }
    const options = { provider: payload.provider, conversation: payload.conversationId }
    if (payload.channel !== undefined) {
      await publishStream(this.make('broadcast'), payload.channel, () => bind().stream(payload.input, options))
      return
    }
    const response = await bind().prompt(payload.input, options)
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

/**
 * Publishes every chunk of the run's UI-message stream, then fails the job on an `error` chunk. A run
 * that throws before its stream ends still publishes one `error` chunk, or subscribers would wait forever.
 */
async function publishStream(broadcast: BroadcastManager, channel: string, stream: () => Promise<Response>): Promise<void> {
  const publish = (chunk: UIMessageChunk) => broadcast.broadcast(channel, AGENT_CHUNK_EVENT, chunk)
  let ended = false
  try {
    const response = await stream()
    const chunks = parseJsonEventStream({ stream: response.body!, schema: uiMessageChunkSchema })
    for await (const parsed of chunks) {
      if (!parsed.success) throw parsed.error
      await publish(parsed.value)
      if (parsed.value.type === 'error') {
        ended = true
        throw new Error(parsed.value.errorText)
      }
      if (parsed.value.type === 'finish') ended = true
    }
  } catch (error) {
    // Masked like the stream's own error chunks: the transcript's subscribers are not its operators.
    if (!ended) await publish({ type: 'error', errorText: 'The agent run failed.' })
    throw error
  }
}
