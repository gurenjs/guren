/**
 * What an `Agent` instance was bound with. Kept off the instance, in a WeakMap, so
 * a subclass cannot read or replace the container or widen its own principal.
 */
import type { AgentInvocationPipeline, AgentPrincipal, Container } from '@guren/core'

import type { AgentClass } from './agent'

export interface AgentContext {
  container: Container
  principal: AgentPrincipal | null
  cls: AgentClass
  /** Built on the first `appTools()` call, then shared by every tool of the instance. */
  pipeline?: AgentInvocationPipeline
}

const contexts = new WeakMap<object, AgentContext>()

export function setAgentContext(agent: object, context: AgentContext): void {
  contexts.set(agent, context)
}

export function readAgentContext(agent: object): AgentContext {
  const context = contexts.get(agent)
  if (!context) {
    throw new Error('This Agent was not constructed through as(principal), so it is bound to no application.')
  }
  return context
}
