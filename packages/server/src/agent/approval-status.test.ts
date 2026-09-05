import { describe, test, expect } from 'bun:test'

import { approvalStatusNotFoundMessage, toApprovalStatusReport } from './approval-status'
import { agentApprovalPrincipalKey, type AgentApprovalRequest } from './approval'
import type { AgentPrincipal } from './events'

/**
 * The rule two surfaces share (RFC 0016 §5.4): `guren.approval_status` over MCP
 * and a durable agent's own check. Its own file because the answer is read by
 * both, and one of its branches is a deliberate refusal to distinguish.
 */

const NOW = new Date('2026-09-06T12:00:00.000Z')

const CALLER: AgentPrincipal = { kind: 'service', id: 'agent:triager:inbox-1', abilities: [] }
const STRANGER: AgentPrincipal = { kind: 'service', id: 'agent:triager:inbox-2', abilities: [] }

function record(overrides: Partial<AgentApprovalRequest> = {}): AgentApprovalRequest {
  return {
    id: 'req-1',
    tool: 'posts.destroy',
    input: { id: 5 },
    fingerprint: 'fp',
    principal: CALLER,
    principalKey: agentApprovalPrincipalKey(CALLER),
    requestedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    status: 'pending',
    ...overrides,
  }
}

describe('toApprovalStatusReport', () => {
  test('should report a pending request to the caller that created it', () => {
    const outcome = toApprovalStatusReport('req-1', record(), CALLER, NOW)

    expect(outcome).toEqual({
      report: {
        requestId: 'req-1',
        status: 'pending',
        tool: 'posts.destroy',
        requestedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        executed: false,
      },
    })
  })

  test('should derive expiry from the clock rather than the stored status', () => {
    const lapsed = record({ expiresAt: new Date(NOW.getTime() - 1).toISOString() })

    expect(toApprovalStatusReport('req-1', lapsed, CALLER, NOW)).toMatchObject({
      report: { status: 'expired' },
    })
  })

  test('should report a spent approval as consumed', () => {
    // Still approved — a human said yes — but the one call it permitted has run.
    // A caller repeating it files a fresh request and acts a second time.
    const spent = record({ status: 'approved', consumedAt: NOW.toISOString() })

    expect(toApprovalStatusReport('req-1', spent, CALLER, NOW)).toMatchObject({
      report: { status: 'approved', consumedAt: NOW.toISOString() },
    })
  })

  test('should omit consumedAt while the approval is still available', () => {
    const approved = record({ status: 'approved' })
    const outcome = toApprovalStatusReport('req-1', approved, CALLER, NOW)

    expect('report' in outcome && 'consumedAt' in outcome.report).toBe(false)
  })

  test('should answer an unknown id and another principal id identically', () => {
    // Any difference here turns the check into a way to enumerate other
    // principals' pending actions.
    const foreign = toApprovalStatusReport('req-1', record(), STRANGER, NOW)
    const unknown = toApprovalStatusReport('req-1', null, CALLER, NOW)

    expect(foreign).toEqual({ notFound: approvalStatusNotFoundMessage('req-1'), foreign: true })
    expect(unknown).toEqual({ notFound: approvalStatusNotFoundMessage('req-1'), foreign: false })
  })

  test('should keep the found/not-found distinction for the operator only', () => {
    // `foreign` rides beside the message for the audit event; the message the
    // caller sees is the same either way.
    const foreign = toApprovalStatusReport('req-1', record(), STRANGER, NOW)
    const unknown = toApprovalStatusReport('req-1', null, CALLER, NOW)

    expect('notFound' in foreign && 'notFound' in unknown
      && foreign.notFound === unknown.notFound).toBe(true)
    expect('foreign' in foreign && foreign.foreign).toBe(true)
  })
})
