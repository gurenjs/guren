import { describe, expect, test } from 'bun:test'

import {
  agentApprovalFingerprint,
  agentApprovalPrincipalKey,
  agentApprovalUsableAt,
} from '@guren/core'

import { AgentApproval } from '../app/Models/AgentApproval'
import { approvalStore } from '../app/Services/DrizzleApprovalStore'
import { agentPrincipal, parkApproval } from './support/app'

describe('DrizzleApprovalStore', () => {
  test('should find a stored request by id, with the principal it recorded', async () => {
    const created = await parkApproval({ id: 101 })

    const found = await approvalStore.find(created.id)

    expect(found?.tool).toBe('tickets.close')
    expect(found?.principal).toEqual(agentPrincipal)
    expect(found?.principalKey).toBe(agentApprovalPrincipalKey(agentPrincipal))
    // Absent, not null: the interface's optional fields drop the key.
    expect(found).not.toHaveProperty('consumedAt')
  })

  test('should match on tool, fingerprint and principal together', async () => {
    const created = await parkApproval({ id: 102 })
    const match = {
      tool: created.tool,
      fingerprint: created.fingerprint,
      principalKey: created.principalKey,
    }

    expect((await approvalStore.findMatch(match))?.id).toBe(created.id)
    // A different caller's approval is not this caller's, on the same arguments.
    expect(await approvalStore.findMatch({ ...match, principalKey: 'user:n:1' })).toBeNull()
    // And the same caller asking about different arguments matches nothing.
    expect(
      await approvalStore.findMatch({
        ...match,
        fingerprint: await agentApprovalFingerprint({ id: 999 }),
      }),
    ).toBeNull()
  })

  test('should return the newest unconsumed match when several exist', async () => {
    const older = await parkApproval({ id: 103 })
    await new Promise((resolve) => setTimeout(resolve, 2))
    const newer = await parkApproval({ id: 103 })

    const match = {
      tool: newer.tool,
      fingerprint: newer.fingerprint,
      principalKey: newer.principalKey,
    }
    expect((await approvalStore.findMatch(match))?.id).toBe(newer.id)
    expect(older.id).not.toBe(newer.id)
  })

  test('should let exactly one of two concurrent consumers win', async () => {
    const created = await parkApproval({ id: 104 })

    const results = await Promise.all([
      approvalStore.consume(created.id),
      approvalStore.consume(created.id),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
  })

  test('should prune a request that lapsed without ever being answered', async () => {
    // Stored `pending` forever: `agentApprovalStatusAt` derives `expired` and
    // nothing writes that back, so a status filter alone never collects it.
    const lapsed = await parkApproval({ id: 106 }, new Date('2020-01-01T00:00:00.000Z'))
    const live = await parkApproval({ id: 107 })

    expect(await approvalStore.pruneSettled(new Date('2021-01-01T00:00:00.000Z'))).toBe(1)

    expect(await approvalStore.find(lapsed.id)).toBeNull()
    expect(await approvalStore.find(live.id)).not.toBeNull()
  })

  test('should stop matching once consumed, so a spent approval is not reused', async () => {
    const created = await parkApproval({ id: 105 })
    await AgentApproval.where('id', created.id).update({ status: 'approved' })
    const match = {
      tool: created.tool,
      fingerprint: created.fingerprint,
      principalKey: created.principalKey,
    }

    const before = await approvalStore.findMatch(match)
    expect(before && agentApprovalUsableAt(before, new Date())).toBe(true)

    expect(await approvalStore.consume(created.id)).toBe(true)
    expect(await approvalStore.findMatch(match)).toBeNull()
    expect((await approvalStore.find(created.id))?.consumedAt).toBeString()
  })
})
