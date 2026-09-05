import { describe, test, expect } from 'bun:test'

import type { AgentApprovalMatch, AgentApprovalRequest, AgentApprovalStore } from './approval'
import { deriveAgentTools, type DerivedAgentTool } from './derive'
import { DEFAULT_SCOPE_SUBJECT, gateApproval, gatePreflight, gateToolCall } from './gate'
import { Router } from '../mvc/Router'

const NOW = new Date('2026-09-01T12:00:00.000Z')

function tools(): { read: DerivedAgentTool; write: DerivedAgentTool; approval: DerivedAgentTool } {
  const router = new Router()
  const handler = () => new Response('ok')
  router.get('/posts', handler).name('posts.index').agent({})
  router.post('/posts', handler).name('posts.store').agent({})
  router.delete('/posts/:id', handler).name('posts.destroy').agent({ approval: 'required' })
  const derived = deriveAgentTools(router.definitions()).tools
  const byName = new Map(derived.map((tool) => [tool.toolName, tool]))
  return {
    read: byName.get('posts.index')!,
    write: byName.get('posts.store')!,
    approval: byName.get('posts.destroy')!,
  }
}

describe('gateToolCall', () => {
  test('should allow a tool the scopes grant', () => {
    expect(gateToolCall(tools().write, ['tool:posts.store'])).toEqual({ allowed: true })
  })

  test('should deny with reason scope when no entry grants the tool', () => {
    const verdict = gateToolCall(tools().write, ['tools:read', '*'])
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toBe('scope')
  })

  test('should judge tools:read by the resolved read-only annotation', () => {
    const { read, write } = tools()
    expect(gateToolCall(read, ['tools:read']).allowed).toBe(true)
    expect(gateToolCall(write, ['tools:read']).allowed).toBe(false)
  })

  test('should deny an approval-required tool even when scopes grant it', () => {
    const verdict = gateToolCall(tools().approval, ['tools:*'])
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toBe('approval')
  })

  // The same tool with a queue behind it. Admitting it here is what puts it in
  // `tools/list`: the call becomes a pending request, and hiding a tool whose
  // whole point is to ask would make the queue unreachable.
  test('should admit an approval-required tool once a queue is configured', () => {
    expect(gateToolCall(tools().approval, ['tools:*'], { approvalsConfigured: true })).toEqual({
      allowed: true,
    })
  })

  test('should report scope before approval, so probes cannot map approval gates', () => {
    const verdict = gateToolCall(tools().approval, [])
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toBe('scope')
  })

  test('should still take scope first when a queue is configured', () => {
    const verdict = gateToolCall(tools().approval, [], { approvalsConfigured: true })
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toBe('scope')
  })

  // The pipeline is protocol-neutral, so the configuration line comes from the
  // surface; with no hint the refusal must still *say* how to configure a
  // queue, or a fail-closed answer sends a caller looking for a switch it
  // cannot find. Exact equality, not `toContain`: the release notes promise an
  // MCP client this text byte for byte, and a stray space is the drift caught.
  test('should name the surface\'s own configuration line when one is given', () => {
    const verdict = gateToolCall(tools().approval, ['tools:*'], {
      configureHint: 'mcpPlugin({ approvals: { store, notify } })',
    })
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) {
      expect(verdict.message).toBe(
        'The tool "posts.destroy" requires server-side approval, and this server has no approval '
        + 'queue configured. Nothing was executed. Configure one with '
        + 'mcpPlugin({ approvals: { store, notify } }).',
      )
    }
  })

  test('should fall back to the pipeline\'s own vocabulary with no hint', () => {
    const verdict = gateToolCall(tools().approval, ['tools:*'])
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) {
      expect(verdict.message).toBe(
        'The tool "posts.destroy" requires server-side approval, and this server has no approval '
        + 'queue configured. Nothing was executed. Configure one with an approval queue on the '
        + 'invocation pipeline (approvals: { store, notify }).',
      )
    }
  })
})

/**
 * Whose scopes a refusal names. It must not say "The token's scopes"
 * unconditionally: that claims a credential only one surface has, and a durable
 * agent's principal, minted from its registration, holds none — widening one
 * names a thing its operator cannot find. The subject is the caller's to supply,
 * and both spellings are pinned exactly, the bearer one by release-note promise.
 */
describe('the scope refusal subject', () => {
  test('should name the caller neutrally by default', () => {
    const verdict = gatePreflight(tools().write, ['tools:read'])
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) {
      expect(verdict.message).toBe('The caller\'s scopes do not grant the tool "posts.store".')
    }
  })

  test('should offer that default as a constant a surface can spell', () => {
    expect(DEFAULT_SCOPE_SUBJECT).toBe("The caller's scopes")
  })

  test('should name the token when a bearer surface says so', () => {
    const verdict = gatePreflight(tools().write, ['tools:read'], {
      scopeSubject: "The token's scopes",
    })
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) {
      expect(verdict.message).toBe('The token\'s scopes do not grant the tool "posts.store".')
    }
  })

  // `gateToolCall` delegates its scope half to `gatePreflight`, so a subject
  // that reached only one of them would leave a rehearsal and a real call
  // describing the same refusal differently.
  test('should reach the call path as well as the rehearsal', () => {
    const verdict = gateToolCall(tools().write, ['tools:read'], {
      scopeSubject: "The token's scopes",
    })
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) {
      expect(verdict.message).toBe('The token\'s scopes do not grant the tool "posts.store".')
    }
  })
})

/**
 * A store with no cleverness in it: an array, and a `consume` that is a
 * compare-and-set because the interface says one is required. Nothing here
 * filters expiry or status — that is the framework's job, and a fixture that
 * filtered would hide a gate that had stopped checking.
 */
class MemoryApprovalStore implements AgentApprovalStore {
  readonly records: AgentApprovalRequest[] = []

  async create(request: AgentApprovalRequest): Promise<void> {
    this.records.push(request)
  }

  async find(id: string): Promise<AgentApprovalRequest | null> {
    return this.records.find((record) => record.id === id) ?? null
  }

  async findMatch(match: AgentApprovalMatch): Promise<AgentApprovalRequest | null> {
    const matched = this.records.filter(
      (record) =>
        record.tool === match.tool
        && record.fingerprint === match.fingerprint
        && record.principalKey === match.principalKey
        && record.consumedAt === undefined,
    )
    return matched[matched.length - 1] ?? null
  }

  async consume(id: string): Promise<boolean> {
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record || record.consumedAt !== undefined) return false
    record.consumedAt = NOW.toISOString()
    return true
  }
}

/**
 * The approval half. Its verdicts are driven end to end through the App MCP
 * endpoint in `@guren/plugin-mcp`'s `approval.test.ts`, which is where the
 * answer a *caller* sees is the thing under test. What lives here is the case
 * no surface can produce.
 */
describe('gateApproval', () => {
  test('should refuse to bind an approval to a call with no identified caller', async () => {
    // `agentApprovalPrincipalKey` answers 'anonymous' for every principal-less
    // caller, so a record filed for one is spendable — and readable through
    // guren.approval_status — by any other. No surface reaches the gate without
    // a verified caller, so this is driven directly: the first adapter to pass
    // null gets a refusal rather than a shared bucket.
    const store = new MemoryApprovalStore()
    const notified: AgentApprovalRequest[] = []

    const verdict = await gateApproval(tools().approval, { id: 5 }, {
      store,
      principal: null,
      now: () => NOW,
      redact: (args) => args,
      notify: (request) => {
        notified.push(request)
      },
    })

    expect(verdict.allowed).toBe(false)
    expect(store.records).toEqual([])
    expect(notified).toEqual([])
  })
})
