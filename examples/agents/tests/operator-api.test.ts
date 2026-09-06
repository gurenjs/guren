import { beforeAll, describe, expect, test } from 'bun:test'

import type { TestApp } from '@guren/testing'

import { approvalStore } from '../app/Services/DrizzleApprovalStore'
import { operatorToken, parkApproval, testApp } from './support/app'

let http: TestApp
let bearer: string

beforeAll(async () => {
  http = await testApp()
  bearer = await operatorToken()
})

function asOperator(): TestApp {
  return http.withHeaders({ Authorization: `Bearer ${bearer}` })
}

describe('tickets', () => {
  test('should refuse an unauthenticated caller', async () => {
    await http.get('/tickets').assertStatus(401)
  })

  test('should list tickets for the operator and filter by status', async () => {
    // One of each status, made here: the suite owns its database and seeds nothing.
    await asOperator().post('/tickets', { title: 'Stays open' }).assertStatus(201)
    const closed = await (
      await asOperator().post('/tickets', { title: 'Closed below' }).assertStatus(201)
    ).json<{ ticket: { id: number } }>()
    await asOperator().post(`/tickets/${closed.ticket.id}/close`, {}).assertOk()

    const all = await (await asOperator().get('/tickets').assertOk()).json<{ tickets: unknown[] }>()
    const open = await (
      await asOperator().get('/tickets?status=open').assertOk()
    ).json<{ tickets: Array<{ status: string }> }>()

    expect(all.tickets.length).toBeGreaterThan(open.tickets.length)
    expect(open.tickets.every((ticket) => ticket.status === 'open')).toBe(true)
  })

  test('should create a backdated ticket and close it', async () => {
    const createdAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString()
    const created = await (
      await asOperator()
        .post('/tickets', { title: 'Stale by construction', createdAt })
        .assertStatus(201)
    ).json<{ ticket: { id: number; createdAt: string } }>()

    expect(created.ticket.createdAt).toBe(createdAt)

    // The operator satisfies the `close-ticket` ability directly; the agent
    // reaches the same route through the approval queue.
    const closed = await (
      await asOperator().post(`/tickets/${created.ticket.id}/close`, {}).assertOk()
    ).json<{ ticket: { status: string } }>()

    expect(closed.ticket.status).toBe('closed')
  })
})

describe('approvals', () => {
  test('should list a parked request and resolve it once', async () => {
    const { id } = await parkApproval({ id: 4242 })

    const listed = await (
      await asOperator().get('/approvals').assertOk()
    ).json<{ pending: Array<{ id: string; tool: string; status: string }> }>()
    expect(listed.pending.find((row) => row.id === id)?.tool).toBe('tickets.close')

    const approved = await (
      await asOperator().post(`/approvals/${id}/approve`, {}).assertOk()
    ).json<{ approval: { status: string; resolvedBy: string } }>()
    expect(approved.approval.status).toBe('approved')
    expect(approved.approval.resolvedBy).toBe('test-operator')

    // Answering twice would hand the agent a second grant for one decision.
    const again = await (
      await asOperator().post(`/approvals/${id}/reject`, {}).assertStatus(409)
    ).json<{ status: string }>()
    expect(again.status).toBe('approved')
  })

  test('should answer 404 for an id the queue never held', async () => {
    // Distinct from the 409 above: nothing to conflict with.
    await asOperator().post(`/approvals/${crypto.randomUUID()}/approve`, {}).assertStatus(404)
  })

  test('should record a rejection the agent can read back', async () => {
    const { id } = await parkApproval({ id: 4243 })

    await asOperator().post(`/approvals/${id}/reject`, {}).assertOk()

    expect((await approvalStore.find(id))?.status).toBe('rejected')
  })

  test('should neither list nor answer a request whose window closed', async () => {
    // Stored `pending`, derived `expired`: the TTL is an hour and this was
    // filed two hours ago.
    const { id } = await parkApproval({ id: 4244 }, new Date(Date.now() - 2 * 60 * 60 * 1000))

    const listed = await (
      await asOperator().get('/approvals').assertOk()
    ).json<{ pending: Array<{ id: string }> }>()
    expect(listed.pending.some((row) => row.id === id)).toBe(false)

    // Answering it would report success for a grant `agentApprovalUsableAt`
    // will refuse the moment the agent tries to spend it.
    const refused = await (
      await asOperator().post(`/approvals/${id}/approve`, {}).assertStatus(409)
    ).json<{ status: string }>()
    expect(refused.status).toBe('expired')
    expect((await approvalStore.find(id))?.status).toBe('pending')
  })

  test('should prune settled and lapsed requests on request', async () => {
    const lapsed = await parkApproval({ id: 4245 }, new Date(Date.now() - 2 * 60 * 60 * 1000))
    const live = await parkApproval({ id: 4246 })

    const body = await (
      await asOperator().post('/approvals/prune', { olderThanDays: 0 }).assertOk()
    ).json<{ pruned: number }>()

    expect(body.pruned).toBeGreaterThan(0)
    expect(await approvalStore.find(lapsed.id)).toBeNull()
    // Still answerable, so still there: pruning is housekeeping, not a sweep.
    expect(await approvalStore.find(live.id)).not.toBeNull()
  })
})

describe('agent operations', () => {
  test('should report that agents need Workers when there is no binding', async () => {
    const body = await (
      await asOperator().post('/ops/agents/triager/sweep', {}).assertStatus(503)
    ).json<{ error: string }>()

    expect(body.error).toContain('Workers')
  })
})
