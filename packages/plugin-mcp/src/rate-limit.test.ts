import { describe, test, expect } from 'bun:test'

import { AgentRateLimiter } from './rate-limit'

describe('AgentRateLimiter', () => {
  test('should exhaust the overall budget within one window', () => {
    const limiter = new AgentRateLimiter({ max: 2, writeMax: 2, windowMs: 1_000 })
    expect(limiter.take('t', { write: false, now: 0 })).toBe(true)
    expect(limiter.take('t', { write: false, now: 1 })).toBe(true)
    expect(limiter.take('t', { write: false, now: 2 })).toBe(false)
  })

  test('should exhaust the write budget before the overall one', () => {
    const limiter = new AgentRateLimiter({ max: 10, writeMax: 1, windowMs: 1_000 })
    expect(limiter.take('t', { write: true, now: 0 })).toBe(true)
    expect(limiter.take('t', { write: true, now: 1 })).toBe(false)
    // Reads still fit in the overall budget.
    expect(limiter.take('t', { write: false, now: 2 })).toBe(true)
  })

  test('should reset when the window rolls over', () => {
    const limiter = new AgentRateLimiter({ max: 1, windowMs: 1_000 })
    expect(limiter.take('t', { write: false, now: 0 })).toBe(true)
    expect(limiter.take('t', { write: false, now: 999 })).toBe(false)
    expect(limiter.take('t', { write: false, now: 1_000 })).toBe(true)
  })

  test('should keep budgets independent per key', () => {
    const limiter = new AgentRateLimiter({ max: 1, windowMs: 1_000 })
    expect(limiter.take('a', { write: false, now: 0 })).toBe(true)
    expect(limiter.take('b', { write: false, now: 0 })).toBe(true)
  })

  test('a refused call should not consume budget', () => {
    const limiter = new AgentRateLimiter({ max: 2, writeMax: 1, windowMs: 1_000 })
    expect(limiter.take('t', { write: true, now: 0 })).toBe(true)
    // Write budget exhausted; this refusal must not eat the overall budget.
    expect(limiter.take('t', { write: true, now: 1 })).toBe(false)
    expect(limiter.take('t', { write: false, now: 2 })).toBe(true)
  })
})
