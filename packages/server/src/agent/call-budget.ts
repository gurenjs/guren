/**
 * A sliding 60-second call budget: the per-caller meter a surface puts at the
 * pipeline's one seam (RFC 0017 §4). It reads nothing of the call, so it is
 * assignable to `AgentInterposition` and also callable for a check that
 * never enters the pipeline, such as an approval status read.
 */
import type { AgentInvocationDenial } from './pipeline'

export interface AgentCallBudgetOptions {
  /** Calls admitted per sliding minute. A whole number of at least 1. */
  callsPerMinute: number
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?: () => number
  /** The denial's text, told to the caller that exhausted the budget. */
  message: (callsPerMinute: number) => string
}

/** Spends one call: a denial when the window is full, `undefined` when the call may proceed. */
export type AgentCallBudget = () => AgentInvocationDenial | undefined

/**
 * One meter per returned function: share the function to share the budget.
 * Throws on a limit that is not a whole number of at least 1.
 */
export function createAgentCallBudget(options: AgentCallBudgetOptions): AgentCallBudget {
  const { callsPerMinute: limit, message } = options
  // Bounded by `limit`: nothing is pushed while the window is full, so `hits`
  // never exceeds it. `Infinity` would make the full-window branch unreachable
  // and let `hits` grow without bound, and `NaN` fails every comparison the
  // same way — an unattended agent unmetered while the config reads as budgeted.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`An agent call budget must be a whole number of calls of at least 1, not ${String(limit)}.`)
  }
  const now = options.now ?? Date.now
  const hits: number[] = []

  return () => {
    const at = now()
    while (hits.length > 0 && hits[0]! <= at - 60_000) {
      hits.shift()
    }
    if (hits.length >= limit) {
      return { reason: 'rate-limit', message: message(limit) }
    }
    hits.push(at)
    return undefined
  }
}
