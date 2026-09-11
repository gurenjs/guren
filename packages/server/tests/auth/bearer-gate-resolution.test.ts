/**
 * The bearer middleware's user has to reach authorization at every mounting
 * order the docs allow, so the cases that can drive a real `Application` do,
 * rather than asserting against a context built here.
 */
process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, it } from 'bun:test'
import { Hono, type Context } from 'hono'
import {
  createApiToken,
  createBearerTokenMiddleware,
  getApiToken,
  MemoryApiTokenStore,
  verifyApiToken,
} from '../../src/auth/api-token'
import { AuthManager } from '../../src/auth/AuthManager'
import { getAuthContext } from '../../src/auth/context'
import type { AuthContext, Guard } from '../../src/auth/types'
import { Gate } from '../../src/authorization'
import { Application } from '../../src/http/Application'
import { attachAuthContext } from '../../src/http/middleware/auth'
import { installAgentPrincipal } from '../../src/internal/agent-principal'
import { fakeGuard, fakeUserProvider } from '../support/fake-auth'

interface ProfileUser {
  id: number
  name: string
}

const SESSION_USER = { id: 7, name: 'Session' }

const loadUser = async (userId: string | number): Promise<ProfileUser> => ({
  id: Number(userId),
  name: 'John',
})

async function bearerFor(store: MemoryApiTokenStore): Promise<string> {
  const { plainTextToken } = await createApiToken(store, { name: 'cli', userId: 1 })
  return `Bearer ${plainTextToken}`
}

/** The Gate's answer beside the context's, so a divergence between them shows. */
function profileHandler(): (c: Context) => Promise<Response> {
  const gate = new Gate().define('read-profile', (user) => (user as ProfileUser | null)?.id === 1)
  return async (c) => {
    const user = await gate.resolveUser(c)
    await gate.forUser(user).authorize('read-profile')
    return c.json({ id: (user as ProfileUser).id, viaContext: await getAuthContext(c)?.user<ProfileUser>() })
  }
}

/** A guard that answers the way a logged-in session guard does. */
function guardFor(user: unknown): Guard<unknown> {
  return fakeGuard({
    check: async () => user !== null,
    guest: async () => user === null,
    user: async <T>() => user as T,
    id: async () => (user as { id: unknown } | null)?.id ?? null,
    attempt: async () => true,
  })
}

/** The framework context an app with a logged-in session carries. */
function sessionUserContext(ctx: Parameters<AuthManager['createAuthContext']>[0]): AuthContext {
  const auth = new AuthManager()
  auth.registerGuard('web', () => guardFor(SESSION_USER))
  auth.setDefaultGuard('web')
  return auth.createAuthContext(ctx)
}

/** Mounts the middleware, and answers a request for the protected route. */
type Wiring = (store: MemoryApiTokenStore) => Promise<(headers: Record<string, string>) => Promise<Response> | Response>

// The documented order is the middleware before boot(), with AuthServiceProvider
// attaching its own context behind it; the rest are orders an app may mount them
// in, and the plain Hono app has no framework context to attach at all.
const WIRINGS: Array<[name: string, mount: Wiring]> = [
  ['a Guren app with auth options, mounted before boot', async (store) => {
    const app = new Application({ auth: {} })
    app.use('/api/*', createBearerTokenMiddleware({ store, loadUser }))
    await app.boot()
    app.hono.get('/api/me', profileHandler())
    return (headers) => app.fetch(new Request('http://example.com/api/me', { headers }))
  }],
  ['a Guren app with auth options, mounted after boot', async (store) => {
    const app = new Application({ auth: {} })
    await app.boot()
    app.hono.use('/api/*', createBearerTokenMiddleware({ store, loadUser }))
    app.hono.get('/api/me', profileHandler())
    return (headers) => app.fetch(new Request('http://example.com/api/me', { headers }))
  }],
  ['a Guren app configured without auth options', async (store) => {
    const app = new Application()
    app.use('/api/*', createBearerTokenMiddleware({ store, loadUser }))
    await app.boot()
    app.hono.get('/api/me', profileHandler())
    return (headers) => app.fetch(new Request('http://example.com/api/me', { headers }))
  }],
  ['a plain Hono app with no auth context', async (store) => {
    const app = new Hono()
    app.use('*', createBearerTokenMiddleware({ store, loadUser }))
    app.get('/me', profileHandler())
    return (headers) => app.request('/me', { headers })
  }],
]

describe('createBearerTokenMiddleware with the Gate', () => {
  it.each(WIRINGS)('should resolve the loaded user on %s', async (_name, mount) => {
    const store = new MemoryApiTokenStore()
    const request = await mount(store)

    const res = await request({ Authorization: await bearerFor(store) })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 1, viaContext: { id: 1, name: 'John' } })
  })

  it('should revoke the presented token on logout', async () => {
    const store = new MemoryApiTokenStore()
    const app = new Hono()
    app.use('*', createBearerTokenMiddleware({ store, loadUser }))
    app.post('/logout', async (c) => {
      await getAuthContext(c)!.logout()
      return c.json({ tokenAfter: getApiToken(c) ?? null })
    })

    const { plainTextToken } = await createApiToken(store, { name: 'cli', userId: 1 })
    const res = await app.request('/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${plainTextToken}` },
    })

    expect(await res.json()).toEqual({ tokenAfter: null })
    expect(await verifyApiToken(plainTextToken, store)).toBeNull()
  })

  // The token verified, so the request is bearer-authenticated and the session
  // user does not stand in for the user the token names.
  it('should report a verified token whose user does not load as unauthenticated', async () => {
    const store = new MemoryApiTokenStore()
    const app = new Hono()
    app.use('*', attachAuthContext(sessionUserContext))
    app.use('*', createBearerTokenMiddleware({ store, loadUser: async () => null }))
    app.get('/me', async (c) => {
      const auth = getAuthContext(c)!
      return c.json({ check: await auth.check(), user: await auth.user(), id: await auth.id() })
    })

    const res = await app.request('/me', { headers: { Authorization: await bearerFor(store) } })

    expect(await res.json()).toEqual({ check: false, user: null, id: null })
  })

  it('should leave the session user alone on a request the middleware never ran for', async () => {
    const store = new MemoryApiTokenStore()
    const app = new Hono()
    app.use('*', attachAuthContext(sessionUserContext))
    app.use('/api/*', createBearerTokenMiddleware({ store, loadUser: async () => null }))
    app.get('/me', async (c) => c.json({ user: await getAuthContext(c)!.user() }))

    const res = await app.request('/me')

    expect(await res.json()).toEqual({ user: SESSION_USER })
  })

  it('should sanitize the loaded user through the provider useTokens configured', async () => {
    const store = new MemoryApiTokenStore()
    const provider = fakeUserProvider({
      getId: (user: unknown) => (user as ProfileUser).id,
      sanitize: (user: unknown) => {
        const { password: _password, ...rest } = user as ProfileUser & { password: string }
        return rest
      },
    })

    const auth = new AuthManager()
    auth.registerProvider('users', () => provider)
    auth.registerGuard('web', () => guardFor(null))
    auth.setDefaultGuard('web')
    auth.useTokens(store, { provider: 'users' })

    const app = new Hono()
    app.use('*', attachAuthContext((ctx) => auth.createAuthContext(ctx)))
    app.use('*', createBearerTokenMiddleware({
      store,
      loadUser: async (userId) => ({ id: Number(userId), name: 'John', password: 'hash' }),
    }))
    app.get('/me', async (c) => c.json({ user: await getAuthContext(c)!.user() }))

    const res = await app.request('/me', { headers: { Authorization: await bearerFor(store) } })

    expect(await res.json()).toEqual({ user: { id: 1, name: 'John' } })
  })

  // RFC 0017 §2: a header must not win over an identity the pipeline itself
  // established, and the slot is written from a header.
  it('should let an installed agent principal outrank the bearer token', async () => {
    const store = new MemoryApiTokenStore()
    const app = new Application()
    app.use('/api/*', createBearerTokenMiddleware({ store, loadUser }))
    await app.boot()
    app.hono.get('/api/me', async (c) => c.json({ user: await getAuthContext(c)!.user() }))

    const request = installAgentPrincipal(new Request('http://example.com/api/me', {
      headers: { Authorization: await bearerFor(store) },
    }), { principal: { kind: 'service', id: 'agent:triager:1' }, abilities: ['tools:*'] })
    const res = await app.fetch(request)

    expect(await res.json()).toEqual({ user: { id: 'agent:triager:1' } })
  })

  it('should not throw when the attached context implements only part of AuthContext', async () => {
    const store = new MemoryApiTokenStore()
    const app = new Hono()
    const partial = { check: async () => false, user: async () => null } as unknown as AuthContext
    app.use('*', attachAuthContext(() => partial))
    app.use('*', createBearerTokenMiddleware({ store, loadUser }))
    app.get('/me', async (c) => c.json({ user: await getAuthContext(c)!.user() }))

    const res = await app.request('/me', { headers: { Authorization: await bearerFor(store) } })

    expect(res.status).toBe(200)
  })
})
