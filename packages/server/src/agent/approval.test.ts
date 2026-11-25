/**
 * The approval queue's pure rules (RFC 0016 §5.4 item 4). Every clock here is
 * seeded at an absolute instant in the *future*: a fake clock at the epoch
 * would make every record expired and every expiry assertion pass anyway.
 */
import { describe, test, expect } from 'bun:test'

import {
  agentApprovalExpiredAt,
  agentApprovalFingerprint,
  agentApprovalFingerprints,
  agentApprovalPrincipalKey,
  agentApprovalStatusAt,
  agentApprovalUsableAt,
  agentApprovalVisibleTo,
  buildAgentApprovalRequest,
  canonicalizeAgentApprovalInput,
  DEFAULT_AGENT_APPROVAL_TTL_MS,
  type AgentApprovalRequest,
} from './approval'

const NOW = new Date('2026-09-01T12:00:00.000Z')

async function pending(
  input: Record<string, unknown> = { id: 5 },
  overrides: Partial<AgentApprovalRequest> = {},
): Promise<AgentApprovalRequest> {
  const request = buildAgentApprovalRequest(
    {
      tool: 'posts.destroy',
      input,
      fingerprint: await agentApprovalFingerprint(input),
      principal: { kind: 'user', id: 7 },
    },
    NOW,
  )
  return { ...request, ...overrides }
}

describe('canonicalizeAgentApprovalInput', () => {
  test('should not depend on key order, at any depth', () => {
    const a = canonicalizeAgentApprovalInput({ b: { y: 2, x: 1 }, a: 1 })
    const b = canonicalizeAgentApprovalInput({ a: 1, b: { x: 1, y: 2 } })
    expect(a).toBe(b)
  })

  test('should distinguish different argument values', () => {
    expect(canonicalizeAgentApprovalInput({ id: 5 })).not.toBe(
      canonicalizeAgentApprovalInput({ id: 9 }),
    )
  })

  test('should distinguish a nested value change under identical keys', () => {
    expect(canonicalizeAgentApprovalInput({ where: { id: 5 } })).not.toBe(
      canonicalizeAgentApprovalInput({ where: { id: 9 } }),
    )
  })

  test('should not normalize types: 5 and "5" are different calls', () => {
    expect(canonicalizeAgentApprovalInput({ id: 5 })).not.toBe(
      canonicalizeAgentApprovalInput({ id: '5' }),
    )
  })

  test('should preserve array order, which is meaning in JSON', () => {
    expect(canonicalizeAgentApprovalInput({ ids: [1, 2] })).not.toBe(
      canonicalizeAgentApprovalInput({ ids: [2, 1] }),
    )
  })

  test('should distinguish an absent key from an explicit null', () => {
    expect(canonicalizeAgentApprovalInput({})).not.toBe(canonicalizeAgentApprovalInput({ id: null }))
  })

  test('should drop undefined values, as JSON does', () => {
    expect(canonicalizeAgentApprovalInput({ id: 5, extra: undefined })).toBe(
      canonicalizeAgentApprovalInput({ id: 5 }),
    )
  })

  test('should ignore inherited keys rather than fingerprinting the prototype', () => {
    const polluted = Object.create({ injected: 'x' }) as Record<string, unknown>
    polluted.id = 5
    expect(canonicalizeAgentApprovalInput(polluted)).toBe(canonicalizeAgentApprovalInput({ id: 5 }))
  })

  test('should throw rather than collapse a value JSON cannot carry', () => {
    expect(() => canonicalizeAgentApprovalInput({ id: 5n as unknown as number })).toThrow()
    expect(() => canonicalizeAgentApprovalInput({ id: Number.NaN })).toThrow()
  })
})

describe('agentApprovalFingerprint', () => {
  test('should match for the same call written with different key order', async () => {
    expect(await agentApprovalFingerprint({ a: 1, b: 2 })).toBe(
      await agentApprovalFingerprint({ b: 2, a: 1 }),
    )
  })

  test('should differ for different arguments', async () => {
    expect(await agentApprovalFingerprint({ id: 5 })).not.toBe(
      await agentApprovalFingerprint({ id: 9 }),
    )
  })

  test('should be a 64-character hex digest, carrying no argument text', async () => {
    const fingerprint = await agentApprovalFingerprint({ password: 'hunter2' })
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprint).not.toContain('hunter2')
  })
})

const KEY_A = new Uint8Array(32).fill(1)
const KEY_B = new Uint8Array(32).fill(2)

describe('agentApprovalFingerprint under a key', () => {
  test('should differ from the bare hash, so the store alone cannot test a guess', async () => {
    const input = { id: 5, password: 'hunter2' }
    expect(await agentApprovalFingerprint(input, KEY_A)).not.toBe(await agentApprovalFingerprint(input))
  })

  test('should be stable for one key and differ between keys', async () => {
    const input = { id: 5 }
    expect(await agentApprovalFingerprint(input, KEY_A)).toBe(await agentApprovalFingerprint(input, KEY_A))
    expect(await agentApprovalFingerprint(input, KEY_A)).not.toBe(await agentApprovalFingerprint(input, KEY_B))
  })

  test('should still ignore key order and be a 64-character hex digest', async () => {
    const fingerprint = await agentApprovalFingerprint({ a: 1, b: 2 }, KEY_A)
    expect(fingerprint).toBe(await agentApprovalFingerprint({ b: 2, a: 1 }, KEY_A))
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('agentApprovalFingerprints', () => {
  test('should put the current key first, then previous keys, then the bare hash', async () => {
    const input = { id: 5 }
    expect(await agentApprovalFingerprints(input, { current: KEY_A, previous: [KEY_B] })).toEqual([
      await agentApprovalFingerprint(input, KEY_A),
      await agentApprovalFingerprint(input, KEY_B),
      await agentApprovalFingerprint(input),
    ])
  })

  test('should write with the bare hash when there is no current key', async () => {
    const input = { id: 5 }
    expect(await agentApprovalFingerprints(input, { previous: [KEY_B] })).toEqual([
      await agentApprovalFingerprint(input),
      await agentApprovalFingerprint(input, KEY_B),
    ])
    expect(await agentApprovalFingerprints(input, { previous: [] })).toEqual([
      await agentApprovalFingerprint(input),
    ])
  })

  test('should not repeat a key listed as both current and previous', async () => {
    const fingerprints = await agentApprovalFingerprints({ id: 5 }, { current: KEY_A, previous: [KEY_A] })
    expect(fingerprints).toHaveLength(2)
  })
})

describe('agentApprovalPrincipalKey', () => {
  test('should separate a numeric id from the same id as a string', () => {
    expect(agentApprovalPrincipalKey({ kind: 'user', id: 5 })).not.toBe(
      agentApprovalPrincipalKey({ kind: 'user', id: '5' }),
    )
  })

  test('should separate kinds', () => {
    expect(agentApprovalPrincipalKey({ kind: 'user', id: 5 })).not.toBe(
      agentApprovalPrincipalKey({ kind: 'service', id: 5 }),
    )
  })

  test('should ignore abilities, so a re-scoped token keeps its approvals', () => {
    expect(agentApprovalPrincipalKey({ kind: 'user', id: 5, abilities: ['tools:read'] })).toBe(
      agentApprovalPrincipalKey({ kind: 'user', id: 5, abilities: ['tools:*'] }),
    )
  })

  test('should give an absent principal a key of its own', () => {
    expect(agentApprovalPrincipalKey(null)).toBe('anonymous')
  })
})

describe('buildAgentApprovalRequest', () => {
  test('should expire one TTL after the instant it was given', async () => {
    const request = await pending()
    expect(request.requestedAt).toBe(NOW.toISOString())
    expect(Date.parse(request.expiresAt) - NOW.getTime()).toBe(DEFAULT_AGENT_APPROVAL_TTL_MS)
    expect(request.status).toBe('pending')
  })

  test('should give every request its own id', async () => {
    expect((await pending()).id).not.toBe((await pending()).id)
  })
})

describe('agentApprovalUsableAt', () => {
  test('should authorize an approved, unexpired, unconsumed record', async () => {
    const request = await pending({ id: 5 }, { status: 'approved' })
    expect(agentApprovalUsableAt(request, NOW)).toBe(true)
  })

  test('should not authorize a record past its expiry', async () => {
    const request = await pending({ id: 5 }, { status: 'approved' })
    const later = new Date(Date.parse(request.expiresAt) + 1)
    expect(agentApprovalUsableAt(request, later)).toBe(false)
  })

  test('should not authorize a record that was already consumed', async () => {
    const request = await pending(
      { id: 5 },
      { status: 'approved', consumedAt: NOW.toISOString() },
    )
    expect(agentApprovalUsableAt(request, NOW)).toBe(false)
  })

  test('should not authorize a pending or rejected record', async () => {
    expect(agentApprovalUsableAt(await pending(), NOW)).toBe(false)
    expect(agentApprovalUsableAt(await pending({ id: 5 }, { status: 'rejected' }), NOW)).toBe(false)
  })

  test('should treat an unreadable expiry as expired rather than as forever', async () => {
    const request = await pending({ id: 5 }, { status: 'approved', expiresAt: 'whenever' })
    expect(agentApprovalExpiredAt(request, NOW)).toBe(true)
    expect(agentApprovalUsableAt(request, NOW)).toBe(false)
  })
})

describe('agentApprovalStatusAt', () => {
  test('should report a pending record past its window as expired', async () => {
    const request = await pending()
    const later = new Date(Date.parse(request.expiresAt) + 1)
    expect(agentApprovalStatusAt(request, NOW)).toBe('pending')
    expect(agentApprovalStatusAt(request, later)).toBe('expired')
  })

  test('should keep a rejection a rejection after the window closes', async () => {
    const request = await pending({ id: 5 }, { status: 'rejected' })
    const later = new Date(Date.parse(request.expiresAt) + 1)
    expect(agentApprovalStatusAt(request, later)).toBe('rejected')
  })
})

describe('agentApprovalVisibleTo', () => {
  test('should show a record to the principal that created it', async () => {
    const request = await pending()
    expect(agentApprovalVisibleTo(request, { kind: 'user', id: 7 })).toBe(true)
  })

  test('should hide a record from every other principal', async () => {
    const request = await pending()
    expect(agentApprovalVisibleTo(request, { kind: 'user', id: 8 })).toBe(false)
    expect(agentApprovalVisibleTo(request, { kind: 'service', id: 7 })).toBe(false)
    expect(agentApprovalVisibleTo(request, null)).toBe(false)
  })
})
