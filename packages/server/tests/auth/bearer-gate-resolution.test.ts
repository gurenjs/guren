import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createApiToken, createBearerTokenMiddleware, MemoryApiTokenStore } from '../../src/auth/api-token'
import { getAuthContext } from '../../src/auth/context'
import type { AuthContext } from '../../src/auth/types'
import { Gate } from '../../src/authorization'
import { attachAuthContext } from '../../src/http/middleware/auth'

interface ProfileUser {
  id: number
  name: string
}

/** The context an app with cookie sessions attaches: no session, so no user. */
function sessionlessContext(): AuthContext {
  return {
    check: async () => false,
    guest: async () => true,
    user: async () => null,
    userOrFail: async () => { throw new Error('unauthenticated') },
    id: async () => null,
    login: async () => {},
    attempt: async () => false,
    logout: async () => {},
    guard: () => { throw new Error('no guard') },
    session: () => undefined,
  }
}

async function bearerFor(store: MemoryApiTokenStore): Promise<string> {
  const { plainTextToken } = await createApiToken(store, { name: 'cli', userId: 1 })
  return `Bearer ${plainTextToken}`
}

function profileRoute(app: Hono, gate: Gate): void {
  app.get('/me', async (c) => {
    const user = await gate.resolveUser(c)
    await gate.forUser(user).authorize('read-profile')
    return c.json({ id: (user as ProfileUser).id, viaContext: await getAuthContext(c)?.user<ProfileUser>() })
  })
}

describe('createBearerTokenMiddleware with the Gate', () => {
  const loadUser = async (userId: string | number): Promise<ProfileUser> => ({ id: Number(userId), name: 'John' })

  it('should resolve the loaded user through Gate.resolveUser when no auth context is attached', async () => {
    const store = new MemoryApiTokenStore()
    const gate = new Gate().define('read-profile', (user) => (user as ProfileUser | null)?.id === 1)
    const app = new Hono()
    app.use('*', createBearerTokenMiddleware({ store, loadUser }))
    profileRoute(app, gate)

    const res = await app.request('/me', { headers: { Authorization: await bearerFor(store) } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 1, viaContext: { id: 1, name: 'John' } })
  })

  it('should let the bearer user win over an attached context that has no session user', async () => {
    const store = new MemoryApiTokenStore()
    const gate = new Gate().define('read-profile', (user) => (user as ProfileUser | null)?.id === 1)
    const app = new Hono()
    app.use('*', attachAuthContext(() => sessionlessContext()))
    app.use('*', createBearerTokenMiddleware({ store, loadUser }))
    profileRoute(app, gate)

    const res = await app.request('/me', { headers: { Authorization: await bearerFor(store) } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 1, viaContext: { id: 1, name: 'John' } })
  })

  it('should report an unresolvable user as unauthenticated rather than falling back', async () => {
    const store = new MemoryApiTokenStore()
    const app = new Hono()
    app.use('*', attachAuthContext(() => sessionlessContext()))
    app.use('*', createBearerTokenMiddleware({ store, loadUser: async () => null }))
    app.get('/me', async (c) => {
      const auth = getAuthContext(c)!
      return c.json({ check: await auth.check(), user: await auth.user(), id: await auth.id() })
    })

    const res = await app.request('/me', { headers: { Authorization: await bearerFor(store) } })

    expect(await res.json()).toEqual({ check: false, user: null, id: null })
  })
})
