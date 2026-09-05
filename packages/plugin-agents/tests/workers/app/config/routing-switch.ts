/**
 * The `/agents/*` authorizer the workerd suite moves between cases.
 *
 * One deploy has to exercise both halves of RFC 0017 §6's default-deny, and the
 * generated worker reads `agentsConfig.routing` per request — so the switch is
 * a module the tests drive over HTTP (`GET /__probe/routing`), never by
 * importing this file.
 */
import type { AgentRouteTarget, AgentsRoutingConfig } from '../../../../src/config'

export type RoutingMode = 'absent' | 'allow' | 'deny' | 'response' | 'throw'

let mode: RoutingMode = 'absent'
let seen: AgentRouteTarget | undefined

export function setRoutingMode(next: RoutingMode): void {
  mode = next
  seen = undefined
}

/** The last target an authorizer saw, so a test can assert what the SDK reported. */
export function lastRoutedTarget(): AgentRouteTarget | undefined {
  return seen
}

export function agentRouting(): AgentsRoutingConfig | undefined {
  if (mode === 'absent') return undefined

  return {
    authorize: (_request, target) => {
      if (mode === 'throw') throw new Error('the authorizer itself failed')
      seen = target
      if (mode === 'response') return new Response('teapot', { status: 418 })
      return mode === 'allow'
    },
  }
}
