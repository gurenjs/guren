/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from 'cloudflare:workers'
import { SELF, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

import type { TestAgent } from './app/app/Agents/TestAgent'
import type { ThriftyAgent } from './app/app/Agents/ThriftyAgent'

/**
 * The pending-approval ledger inside a real Durable Object (RFC 0017 §5).
 *
 * What Bun cannot reach: DO SQLite, the SDK's schedules, and eviction. The
 * queue's own side is read over HTTP so no assertion rests on the suite and the
 * worker sharing a module instance.
 */

interface TestEnv {
  TEST_AGENT: DurableObjectNamespace<TestAgent>
  THRIFTY_AGENT: DurableObjectNamespace<ThriftyAgent>
}

const bindings = env as unknown as TestEnv

interface ApprovalRecord {
  id: string
  tool: string
  status: string
  expiresAt: string
  consumed: boolean
}

interface Probe {
  destroyed: number[]
  approvals: ApprovalRecord[]
}

let instance = 0

function freshAgent(): DurableObjectStub<TestAgent> {
  instance += 1
  const name = `approver-${instance}`
  return bindings.TEST_AGENT.get(bindings.TEST_AGENT.idFromName(name))
}

async function probe(): Promise<Probe> {
  const response = await SELF.fetch('https://fixture.test/__probe')
  expect(response.status).toBe(200)
  return (await response.json()) as Probe
}

async function resolve(id: string, verdict: 'approved' | 'rejected' | 'expire'): Promise<void> {
  const response = await SELF.fetch(
    `https://fixture.test/__probe/approvals?id=${id}&verdict=${verdict}`,
  )
  expect(response.status).toBe(200)
}

/** Either fixture class: both are `GurenAgent`s with a ledger behind them. */
type LedgerAgent = TestAgent | ThriftyAgent

/** The ledger's own rows, straight out of the agent's SQLite. */
function ledgerRows<A extends LedgerAgent>(
  stub: DurableObjectStub<A>,
): Promise<Array<Record<string, string | number | boolean | null>>> {
  return runInDurableObject(stub, (agent) =>
    agent.sql`SELECT * FROM guren_pending_tool_calls`)
}

function checkSchedules<A extends LedgerAgent>(stub: DurableObjectStub<A>): Promise<string[]> {
  return runInDurableObject(stub, async (agent) =>
    (await agent.listSchedules({ type: 'delayed' }))
      .filter((schedule) => schedule.callback === 'checkPendingApprovals')
      .map((schedule) => schedule.id))
}

/**
 * Bring the SDK's own schedule rows forward so an alarm has something due.
 *
 * `runDurableObjectAlarm` fires now, but the SDK's handler runs only schedules
 * whose `time` has passed, and the ledger's first backoff is 30s. Reaching into
 * `cf_agents_schedules` is what tests the alarm path in under a second.
 */
async function makeDue(stub: DurableObjectStub<TestAgent>): Promise<void> {
  await runInDurableObject(stub, (agent) => {
    void agent.sql`UPDATE cf_agents_schedules SET time = ${Math.floor(Date.now() / 1000) - 1}`
  })
}

function thriftyAgent(): DurableObjectStub<ThriftyAgent> {
  instance += 1
  const name = `thrifty-${instance}`
  return bindings.THRIFTY_AGENT.get(bindings.THRIFTY_AGENT.idFromName(name))
}

async function setHookThrows(throws: boolean): Promise<void> {
  const response = await SELF.fetch(
    `https://fixture.test/__probe/hook?throws=${throws ? 'yes' : 'no'}`,
  )
  expect(response.status).toBe(200)
}

async function breakQueue(times: number): Promise<void> {
  const response = await SELF.fetch(`https://fixture.test/__probe/break?times=${times}`)
  expect(response.status).toBe(200)
}

async function park(stub: DurableObjectStub<TestAgent>, id: number): Promise<string> {
  const result = await runInDurableObject(stub, (agent) => agent.destroyPost(id))
  expect(result.pending).toBe(true)
  if (!result.pending) throw new Error('unreachable')
  return result.requestId
}

function settled(stub: DurableObjectStub<TestAgent>): Promise<TestAgent['state']['settled']> {
  return runInDurableObject(stub, (agent) => agent.state.settled)
}

beforeEach(async () => {
  const response = await SELF.fetch('https://fixture.test/__probe/reset')
  expect(response.status).toBe(200)
})

describe('a call the approval queue parks', () => {
  it('should checkpoint the arguments and schedule exactly one check', async () => {
    const stub = freshAgent()

    const requestId = await park(stub, 41)

    const rows = await ledgerRows(stub)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.request_id).toBe(requestId)
    expect(rows[0]!.tool).toBe('posts.destroy')
    expect(rows[0]!.checks).toBe(0)
    expect(await checkSchedules(stub)).toHaveLength(1)
    // Nothing ran: the whole point of a parked call.
    expect((await probe()).destroyed).toEqual([])
  })

  it('should store the arguments encrypted at rest', async () => {
    const stub = freshAgent()

    await park(stub, 987654)

    const [row] = await ledgerRows(stub)
    // A leaked snapshot of this Durable Object must not disclose what the agent
    // asked for — the queue's own record is redacted for the same reason.
    expect(String(row!.args)).not.toContain('987654')
    expect(String(row!.args)).not.toContain('"id"')
  })

  it('should not schedule a second check for a second parked call', async () => {
    const stub = freshAgent()

    await park(stub, 1)
    await park(stub, 2)

    expect(await ledgerRows(stub)).toHaveLength(2)
    expect(await checkSchedules(stub)).toHaveLength(1)
  })
})

describe('the scheduled check', () => {
  it('should repeat the call once on the alarm when a human approved it', async () => {
    const stub = freshAgent()
    const requestId = await park(stub, 7)

    await resolve(requestId, 'approved')
    await makeDue(stub)
    expect(await runDurableObjectAlarm(stub)).toBe(true)

    // Executed exactly once, and the approval is spent: the retry carries the
    // stored arguments, so the queue's fingerprint match binds it to this call.
    const report = await probe()
    expect(report.destroyed).toEqual([7])
    expect(report.approvals[0]!.consumed).toBe(true)

    expect(await ledgerRows(stub)).toEqual([])
    expect(await settled(stub)).toEqual([
      { requestId, tool: 'posts.destroy', status: 'approved', retried: true, args: { id: 7 } },
    ])
    // Nothing left to wait for, so nothing is scheduled.
    expect(await checkSchedules(stub)).toEqual([])
  })

  it('should drop the row and report a rejection without calling the tool', async () => {
    const stub = freshAgent()
    const requestId = await park(stub, 8)

    await resolve(requestId, 'rejected')
    await runInDurableObject(stub, (agent) => agent.checkPendingApprovals())

    expect((await probe()).destroyed).toEqual([])
    expect(await ledgerRows(stub)).toEqual([])
    expect(await settled(stub)).toEqual([
      { requestId, tool: 'posts.destroy', status: 'rejected', retried: null, args: { id: 8 } },
    ])
  })

  it('should prune a request whose window closed unanswered', async () => {
    const stub = freshAgent()
    const requestId = await park(stub, 9)

    await resolve(requestId, 'expire')
    await runInDurableObject(stub, (agent) => agent.checkPendingApprovals())

    expect((await probe()).destroyed).toEqual([])
    expect(await ledgerRows(stub)).toEqual([])
    expect(await settled(stub)).toEqual([
      { requestId, tool: 'posts.destroy', status: 'expired', retried: null, args: { id: 9 } },
    ])
  })

  it('should report a rejection that landed after the row lapsed', async () => {
    const stub = freshAgent()
    const requestId = await park(stub, 14)
    await resolve(requestId, 'rejected')

    // The row's own expiry passes between the last check and this wake.
    // Dropping it unread would report `expired`, and an application that
    // remembers only rejections would put the same question to the same human
    // on its next sweep.
    await runInDurableObject(stub, (agent) => {
      void agent.sql`UPDATE guren_pending_tool_calls SET expires_at = '2020-01-01T00:00:00.000Z'
        WHERE request_id = ${requestId}`
    })
    await runInDurableObject(stub, (agent) => agent.checkPendingApprovals())

    expect((await probe()).destroyed).toEqual([])
    expect(await ledgerRows(stub)).toEqual([])
    expect(await settled(stub)).toEqual([
      { requestId, tool: 'posts.destroy', status: 'rejected', retried: null, args: { id: 14 } },
    ])
  })

  it('should not retry an approval its row outlived', async () => {
    const stub = freshAgent()
    const requestId = await park(stub, 15)
    await resolve(requestId, 'approved')

    // Approved, but past `expiresAt`: `agentApprovalUsableAt` refuses it, so a
    // retry would find no usable match, file a fresh request and page a human
    // for a call nobody asked about again.
    await runInDurableObject(stub, (agent) => {
      void agent.sql`UPDATE guren_pending_tool_calls SET expires_at = '2020-01-01T00:00:00.000Z'
        WHERE request_id = ${requestId}`
    })
    await runInDurableObject(stub, (agent) => agent.checkPendingApprovals())

    expect((await probe()).destroyed).toEqual([])
    expect(await ledgerRows(stub)).toEqual([])
    expect(await settled(stub)).toEqual([
      { requestId, tool: 'posts.destroy', status: 'expired', retried: null, args: { id: 15 } },
    ])
  })

  it('should keep a still-pending row, count the check, and reschedule once', async () => {
    const stub = freshAgent()
    const requestId = await park(stub, 10)

    await runInDurableObject(stub, (agent) => agent.checkPendingApprovals())

    const rows = await ledgerRows(stub)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.request_id).toBe(requestId)
    // The count is what lengthens the backoff; one schedule is what keeps a
    // sweep from multiplying its own wakes.
    expect(rows[0]!.checks).toBe(1)
    expect(await checkSchedules(stub)).toHaveLength(1)
    expect(await settled(stub)).toEqual([])
  })
})

describe('a check the queue cannot answer', () => {
  it('should keep the row, count the check, and reschedule', async () => {
    const stub = freshAgent()
    const requestId = await park(stub, 12)

    await breakQueue(1)
    await runInDurableObject(stub, (agent) => agent.checkPendingApprovals())

    // Unanswerable is not "no such request": purging here would drop the
    // arguments an approval granted an hour later needs. The count still
    // advances, so a queue that stays down backs off instead of re-asking at
    // one cadence until the request expires.
    const rows = await ledgerRows(stub)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.request_id).toBe(requestId)
    expect(rows[0]!.checks).toBe(1)
    expect(await checkSchedules(stub)).toHaveLength(1)
    expect(await settled(stub)).toEqual([])
  })

  it('should drop a lapsed row it cannot ask about, rather than keep it forever', async () => {
    const stub = freshAgent()
    const requestId = await park(stub, 16)
    await runInDurableObject(stub, (agent) => {
      void agent.sql`UPDATE guren_pending_tool_calls SET expires_at = '2020-01-01T00:00:00.000Z'
        WHERE request_id = ${requestId}`
    })

    await breakQueue(1)
    await runInDurableObject(stub, (agent) => agent.checkPendingApprovals())

    // Nothing can retry it whatever the queue later says, and an elapsed
    // expiry floors the next wake at one second — keeping it is an alarm loop.
    expect(await ledgerRows(stub)).toEqual([])
    expect(await settled(stub)).toEqual([
      { requestId, tool: 'posts.destroy', status: 'expired', retried: null, args: { id: 16 } },
    ])
  })

  it('should still retry once the queue comes back', async () => {
    const stub = freshAgent()
    const requestId = await park(stub, 13)

    await breakQueue(1)
    await runInDurableObject(stub, (agent) => agent.checkPendingApprovals())
    await resolve(requestId, 'approved')
    await runInDurableObject(stub, (agent) => agent.checkPendingApprovals())

    expect((await probe()).destroyed).toEqual([13])
    expect(await ledgerRows(stub)).toEqual([])
  })
})

describe('a sweep interrupted after the call already ran', () => {
  it('should not call the tool or page a human a second time', async () => {
    const stub = freshAgent()
    const requestId = await park(stub, 30)
    await resolve(requestId, 'approved')

    // Stands in for the interruption the SDK's retry creates: the approval is
    // spent and the tool has run, but the ledger row is still there. Same
    // instance, so this is the same principal and the same fingerprint — the
    // gate consumes exactly the approval the sweep was going to spend.
    await runInDurableObject(stub, (agent) => agent.tools.call('posts.destroy', { id: 30 }))
    await runInDurableObject(stub, (agent) => agent.checkPendingApprovals())

    const report = await probe()
    // Once. Re-calling would find no unconsumed match, file a second request,
    // page a human again, and delete the post twice on approval.
    expect(report.destroyed).toEqual([30])
    expect(report.approvals).toHaveLength(1)
    expect(report.approvals[0]!.consumed).toBe(true)

    expect(await ledgerRows(stub)).toEqual([])
    // No `result`: nothing was called this time round.
    expect(await settled(stub)).toEqual([
      { requestId, tool: 'posts.destroy', status: 'approved', retried: null, args: { id: 30 } },
    ])
  })
})

describe('a hook that throws', () => {
  it('should not fail the sweep when it throws outside a row handler', async () => {
    const stub = freshAgent()
    const lapsing = await park(stub, 20)
    await park(stub, 21)
    // The row's own expiry, not the queue record's: the sweep reads what was
    // copied at park time, and resolving the queue side never writes back.
    await runInDurableObject(stub, (agent) => {
      void agent.sql`UPDATE guren_pending_tool_calls SET expires_at = '2020-01-01T00:00:00.000Z'
        WHERE request_id = ${lapsing}`
    })

    await setHookThrows(true)
    // A throw escaping here is retried three times by the SDK and then leaves
    // every surviving row with no schedule at all.
    await runInDurableObject(stub, (agent) => agent.checkPendingApprovals())

    const rows = await ledgerRows(stub)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.checks).toBe(1)
    expect(await checkSchedules(stub)).toHaveLength(1)
  })
})

describe('a row naming a tool the application no longer has', () => {
  it('should keep the row and settle the others', async () => {
    const stub = freshAgent()
    const requestId = await park(stub, 60)
    await park(stub, 61)
    await resolve(requestId, 'approved')

    // What a deploy that dropped a route leaves behind: `client.call` throws
    // rather than answering, and without a per-row catch the whole sweep would
    // die on it at every wake until both rows expired.
    await runInDurableObject(stub, (agent) => {
      void agent.sql`UPDATE guren_pending_tool_calls SET tool = 'posts.gone'
        WHERE request_id = ${requestId}`
    })
    await runInDurableObject(stub, (agent) => agent.checkPendingApprovals())

    const rows = await ledgerRows(stub)
    expect(rows).toHaveLength(2)
    // Both counted: the broken one by its catch, the healthy one as pending.
    expect(rows.map((row) => row.checks)).toEqual([1, 1])
    expect(await checkSchedules(stub)).toHaveLength(1)
  })
})

describe('a retry that runs out of budget', () => {
  it('should keep the approval rather than spend it on a refusal', async () => {
    const stub = thriftyAgent()

    const parked = await runInDurableObject(stub, (agent) => agent.destroyPost(50))
    expect(parked.pending).toBe(true)
    if (!parked.pending) return
    await resolve(parked.requestId, 'approved')

    // The status check is the second of two calls a minute, so the retry is the
    // third and comes back rate-limited.
    await runInDurableObject(stub, (agent) => agent.checkPendingApprovals())

    const report = await probe()
    expect(report.destroyed).toEqual([])
    // Reporting the refusal as the approval's outcome would drop the row, and a
    // human's approval would be spent by nobody and never retried.
    expect(report.approvals[0]!.consumed).toBe(false)

    const rows = await ledgerRows(stub)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.checks).toBe(1)
  })
})

describe('the retry across an eviction', () => {
  it('should repeat the call from durable state alone', async () => {
    const stub = freshAgent()
    const requestId = await park(stub, 11)

    // Everything in memory is gone: the client, its budget, the ledger object.
    // Only DO SQLite and the SDK's schedules survive, which is the rule the
    // design follows rather than parking an awaited promise.
    await evictDurableObject(stub)

    await resolve(requestId, 'approved')
    await makeDue(stub)
    expect(await runDurableObjectAlarm(stub)).toBe(true)

    expect((await probe()).destroyed).toEqual([11])
    expect(await ledgerRows(stub)).toEqual([])
    expect(await settled(stub)).toEqual([
      { requestId, tool: 'posts.destroy', status: 'approved', retried: true, args: { id: 11 } },
    ])
  })
})
