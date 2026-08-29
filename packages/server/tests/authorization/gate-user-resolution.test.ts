import { describe, test, expect } from 'bun:test'
import { Gate } from '../../src/authorization'
import { AUTH_CONTEXT_KEY } from '../../src/http/middleware/auth'
import { fakeContext } from '../support/fake-context'

function fakeAuthContext(user: unknown) {
  return { user: async () => user }
}

describe('Gate.resolveUser', () => {
  test('should resolve the user from the auth context (guren:auth)', async () => {
    const gate = new Gate()
    const ctx = fakeContext({ values: { [AUTH_CONTEXT_KEY]: fakeAuthContext({ id: 7 }) } })

    expect(await gate.resolveUser(ctx)).toEqual({ id: 7 })
  })

  test('should ignore a non-auth-context value stored under the auth key', async () => {
    const gate = new Gate()
    const ctx = fakeContext({ values: { [AUTH_CONTEXT_KEY]: { id: 1 }, user: { id: 3 } } })

    expect(await gate.resolveUser(ctx)).toEqual({ id: 3 })
  })

  test('should fall back to ctx.get("user") when no auth context is attached', async () => {
    const gate = new Gate()
    const ctx = fakeContext({ values: { user: { id: 3 } } })

    expect(await gate.resolveUser(ctx)).toEqual({ id: 3 })
  })

  test('an attached auth context is authoritative even when it has no user', async () => {
    // No fallback to ctx.get('user') here: authentication rejected the
    // request (e.g. invalid Bearer), so authorization must not resurrect a
    // manually-set principal.
    const gate = new Gate()
    const ctx = fakeContext({
      values: {
        [AUTH_CONTEXT_KEY]: fakeAuthContext(null),
        user: { id: 3 },
      },
    })

    expect(await gate.resolveUser(ctx)).toBeNull()
  })

  test('auth context should win over a manually set ctx user', async () => {
    const gate = new Gate()
    const ctx = fakeContext({
      values: {
        [AUTH_CONTEXT_KEY]: fakeAuthContext({ id: 7 }),
        user: { id: 999 },
      },
    })

    expect(await gate.resolveUser(ctx)).toEqual({ id: 7 })
  })

  test('an explicit userResolver should still take precedence', async () => {
    const gate = new Gate({ userResolver: async () => ({ id: 1 }) })
    const ctx = fakeContext({ values: { [AUTH_CONTEXT_KEY]: fakeAuthContext({ id: 7 }) } })

    expect(await gate.resolveUser(ctx)).toEqual({ id: 1 })
  })
})
