import { describe, test, expect } from 'bun:test'
import { Gate } from '../../src/authorization'
import { AUTH_CONTEXT_KEY } from '../../src/http/middleware/auth'
import type { Context } from '../../src/http/Application'

function fakeCtx(values: Record<string, unknown> = {}): Context {
  const store = new Map<string, unknown>(Object.entries(values))
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value)
    },
  } as unknown as Context
}

function fakeAuthContext(user: unknown) {
  return { user: async () => user }
}

describe('Gate.resolveUser', () => {
  test('should resolve the user from the auth context (guren:auth)', async () => {
    const gate = new Gate()
    const ctx = fakeCtx({ [AUTH_CONTEXT_KEY]: fakeAuthContext({ id: 7 }) })

    expect(await gate.resolveUser(ctx)).toEqual({ id: 7 })
  })

  test('should ignore a non-auth-context value stored under the auth key', async () => {
    const gate = new Gate()
    const ctx = fakeCtx({ [AUTH_CONTEXT_KEY]: { id: 1 }, user: { id: 3 } })

    expect(await gate.resolveUser(ctx)).toEqual({ id: 3 })
  })

  test('should fall back to ctx.get("user") when no auth context is attached', async () => {
    const gate = new Gate()
    const ctx = fakeCtx({ user: { id: 3 } })

    expect(await gate.resolveUser(ctx)).toEqual({ id: 3 })
  })

  test('should fall back to ctx.get("user") when the auth context has no user', async () => {
    const gate = new Gate()
    const ctx = fakeCtx({
      [AUTH_CONTEXT_KEY]: fakeAuthContext(null),
      user: { id: 3 },
    })

    expect(await gate.resolveUser(ctx)).toEqual({ id: 3 })
  })

  test('auth context should win over a manually set ctx user', async () => {
    const gate = new Gate()
    const ctx = fakeCtx({
      [AUTH_CONTEXT_KEY]: fakeAuthContext({ id: 7 }),
      user: { id: 999 },
    })

    expect(await gate.resolveUser(ctx)).toEqual({ id: 7 })
  })

  test('an explicit userResolver should still take precedence', async () => {
    const gate = new Gate({ userResolver: async () => ({ id: 1 }) })
    const ctx = fakeCtx({ [AUTH_CONTEXT_KEY]: fakeAuthContext({ id: 7 }) })

    expect(await gate.resolveUser(ctx)).toEqual({ id: 1 })
  })
})
