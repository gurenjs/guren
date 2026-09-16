import { describe, test, expect } from 'bun:test'

import { createAgentCallBudget } from './call-budget'
import type { AgentInterposition } from './pipeline'

function budgetAt(clock: { at: number }, callsPerMinute: number) {
  return createAgentCallBudget({
    callsPerMinute,
    now: () => clock.at,
    message: (limit) => `spent ${limit}`,
  })
}

describe('createAgentCallBudget', () => {
  test('should admit calls up to the limit and deny the next with the given message', () => {
    const clock = { at: 4_000_000_000_000 }
    const consume = budgetAt(clock, 2)

    expect(consume()).toBeUndefined()
    expect(consume()).toBeUndefined()
    expect(consume()).toEqual({ reason: 'rate-limit', message: 'spent 2' })
  })

  test('should admit again once the oldest call leaves the 60-second window', () => {
    const clock = { at: 4_000_000_000_000 }
    const consume = budgetAt(clock, 1)

    expect(consume()).toBeUndefined()
    clock.at += 59_999
    expect(consume()).toBeDefined()
    clock.at += 1
    expect(consume()).toBeUndefined()
  })

  test('should not count a denied call against the window', () => {
    const clock = { at: 4_000_000_000_000 }
    const consume = budgetAt(clock, 1)

    expect(consume()).toBeUndefined()
    clock.at += 30_000
    expect(consume()).toBeDefined()
    clock.at += 30_000
    expect(consume()).toBeUndefined()
  })

  test('should keep a separate window per returned function', () => {
    const clock = { at: 4_000_000_000_000 }
    const first = budgetAt(clock, 1)
    const second = budgetAt(clock, 1)

    expect(first()).toBeUndefined()
    expect(second()).toBeUndefined()
  })

  test('should be accepted where the pipeline takes an interposition', () => {
    const interpose: AgentInterposition = budgetAt({ at: 0 }, 1)
    expect(interpose({ tool: {} as never, args: {}, preflight: false })).toBeUndefined()
  })

  for (const limit of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1, 1.5]) {
    test(`should refuse a limit of ${String(limit)}`, () => {
      expect(() => budgetAt({ at: 0 }, limit)).toThrow(RangeError)
    })
  }
})
