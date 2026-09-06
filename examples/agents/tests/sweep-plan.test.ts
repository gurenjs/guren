import { describe, expect, test } from 'bun:test'

import {
  MAX_ASKS_PER_SWEEP,
  planSweep,
  STALE_DAYS,
  type TicketSummary,
} from '../app/Agents/sweep-plan'

/**
 * The sweep's arithmetic, on Bun. The Durable Object around it is not reachable
 * here — `@guren/plugin-agents/agent` imports `cloudflare:workers` — which is
 * why this half is a module of its own.
 */

const NOW = new Date('2026-09-06T00:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

function ticket(id: number, ageDays: number): TicketSummary {
  return {
    id,
    title: `ticket ${id}`,
    status: 'open',
    createdAt: new Date(NOW.getTime() - ageDays * DAY_MS).toISOString(),
  }
}

function state(overrides: Partial<Parameters<typeof planSweep>[1]> = {}) {
  return { declined: [], parked: {}, ...overrides }
}

describe('planSweep', () => {
  test('should count only tickets older than the stale cutoff', () => {
    const plan = planSweep([ticket(1, STALE_DAYS + 1), ticket(2, 1)], state(), NOW)

    expect(plan.stale.map((row) => row.id)).toEqual([1])
    expect(plan.ask.map((row) => row.id)).toEqual([1])
  })

  test('should skip a ticket a human already refused', () => {
    const plan = planSweep([ticket(1, 30), ticket(2, 30)], state({ declined: [2] }), NOW)

    expect(plan.stale).toHaveLength(2)
    expect(plan.ask.map((row) => row.id)).toEqual([1])
  })

  test('should skip a ticket already parked on a human', () => {
    const parked = { '2': new Date(NOW.getTime() + DAY_MS).toISOString() }

    const plan = planSweep([ticket(1, 30), ticket(2, 30)], state({ parked }), NOW)

    // Re-asking returns the same request, but still costs a tool call and a
    // `findMatch` — which is how pending tickets starve every later id.
    expect(plan.ask.map((row) => row.id)).toEqual([1])
    expect(plan.parked).toEqual(parked)
  })

  test('should ask again once a parked request has expired', () => {
    const parked = {
      '2': new Date(NOW.getTime() - 1).toISOString(),
      '3': 'not a date',
    }

    const plan = planSweep([ticket(2, 30), ticket(3, 30)], state({ parked }), NOW)

    // A request past its window can never be approved, so holding the entry
    // would park that ticket for good.
    expect(plan.ask.map((row) => row.id)).toEqual([2, 3])
    expect(plan.parked).toEqual({})
  })

  test('should cap the asks so one sweep stays inside the D1 query budget', () => {
    const open = Array.from({ length: MAX_ASKS_PER_SWEEP + 5 }, (_, index) =>
      ticket(index + 1, 30))

    const plan = planSweep(open, state(), NOW)

    expect(plan.stale).toHaveLength(MAX_ASKS_PER_SWEEP + 5)
    expect(plan.ask).toHaveLength(MAX_ASKS_PER_SWEEP)
    // 1 index query + 2 per fresh ask, against the Free plan's 50 per invocation.
    expect(1 + 2 * MAX_ASKS_PER_SWEEP).toBeLessThan(50)
  })

  test('should treat an unreadable creation date as not yet stale', () => {
    const plan = planSweep([{ ...ticket(1, 30), createdAt: 'not a date' }], state(), NOW)

    expect(plan.stale).toEqual([])
  })
})
