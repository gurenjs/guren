import { describe, test, expect } from 'bun:test'

import {
  mcpOAuthPropsToAuth,
  presentExternalMcpAuth,
  readExternalMcpAuth,
  type ExternalMcpAuth,
} from './external-auth'

const auth: ExternalMcpAuth = {
  principal: { kind: 'user', id: 42, abilities: ['tools:read'] },
  scopes: ['tools:read'],
}

describe('presentExternalMcpAuth', () => {
  test('should return the very object it was handed, not a copy', () => {
    const request = new Request('http://localhost/mcp')
    expect(presentExternalMcpAuth(request, auth)).toBe(request)
  })

  test('should make the auth readable from that exact request', () => {
    const request = presentExternalMcpAuth(new Request('http://localhost/mcp'), auth)
    expect(readExternalMcpAuth(request)).toEqual(auth)
  })

  /**
   * The security property, and the half a no-op implementation would also
   * pass — which is why it is asserted next to the positive case above rather
   * than alone. A caller who has the bytes of an authenticated request can
   * construct either of these; neither may carry the grant.
   */
  test('should not carry to a request rebuilt from the same URL and headers', () => {
    const request = presentExternalMcpAuth(
      new Request('http://localhost/mcp', { headers: { Authorization: 'Bearer x' } }),
      auth,
    )

    expect(readExternalMcpAuth(new Request(request))).toBeUndefined()
    expect(readExternalMcpAuth(new Request('http://localhost/mcp'))).toBeUndefined()
  })

  test('should not carry to a clone of the presented request', () => {
    const request = presentExternalMcpAuth(
      new Request('http://localhost/mcp', { method: 'POST', body: '{}' }),
      auth,
    )

    expect(readExternalMcpAuth(request.clone())).toBeUndefined()
    // …while the original still carries it, so this cannot pass by the
    // registration having silently failed.
    expect(readExternalMcpAuth(request)).toEqual(auth)
  })

  test('should read undefined for a request nothing was presented for', () => {
    expect(readExternalMcpAuth(new Request('http://localhost/mcp'))).toBeUndefined()
  })
})

describe('mcpOAuthPropsToAuth', () => {
  test('should map a well-formed grant to a user principal carrying its scopes', () => {
    expect(mcpOAuthPropsToAuth({ userId: 'u_1', scopes: ['tool:posts.index'] })).toEqual({
      principal: { kind: 'user', id: 'u_1', abilities: ['tool:posts.index'] },
      scopes: ['tool:posts.index'],
    })
  })

  test('should pass a numeric userId through without coercing it to a string', () => {
    const mapped = mcpOAuthPropsToAuth({ userId: 7, scopes: [] })
    expect(mapped?.principal.id).toBe(7)
  })

  test('should pass a numeric-looking string userId through as a string', () => {
    const mapped = mcpOAuthPropsToAuth({ userId: '7', scopes: [] })
    expect(mapped?.principal.id).toBe('7')
  })

  test('should accept an empty scope grant — authenticated, reaching nothing', () => {
    expect(mcpOAuthPropsToAuth({ userId: 1, scopes: [] })).toEqual({
      principal: { kind: 'user', id: 1, abilities: [] },
      scopes: [],
    })
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'userId=1'],
    ['a number', 1],
    ['an array', ['userId']],
    ['no userId', { scopes: [] }],
    ['a boolean userId', { userId: true, scopes: [] }],
    ['an object userId', { userId: { id: 1 }, scopes: [] }],
    ['an empty-string userId', { userId: '', scopes: [] }],
    ['no scopes', { userId: 1 }],
    ['a string scopes', { userId: 1, scopes: 'tools:*' }],
    ['a non-string scope entry', { userId: 1, scopes: ['tools:read', 7] }],
    ['a null scope entry', { userId: 1, scopes: [null] }],
  ])('should refuse props that are %s', (_label, props) => {
    expect(mcpOAuthPropsToAuth(props)).toBeNull()
  })
})
