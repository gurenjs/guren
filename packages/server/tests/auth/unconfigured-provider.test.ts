import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import type { Context } from 'hono'
import { Application } from '../../src/http/Application'
import { Controller } from '../../src/mvc/Controller'
import { requireAuthenticated } from '../../src/http/middleware/auth'
import { NO_USER_PROVIDER_MESSAGE } from '../../src/auth/providers/unconfigured-user-provider'
import { fakeSession } from '../support/session'

process.env.APP_KEY ??= 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

class LoginController extends Controller {
  async store() {
    const ok = await this.auth.attempt({ email: 'a@example.com', password: 'secret' })
    return this.json({ ok })
  }
}

describe('a login attempt with no user provider registered', () => {
  const warnSpy = spyOn(console, 'warn')
  afterEach(() => warnSpy.mockClear())

  it('throws from the guard, naming the fix', async () => {
    const app = new Application({ auth: {} })
    const guard = app.auth.createGuard('web', { ctx: {} as Context, session: fakeSession(), manager: app.auth })

    await expect(guard.attempt({ email: 'a@example.com', password: 'secret' })).rejects.toThrow(NO_USER_PROVIDER_MESSAGE)
    await expect(guard.validate({ email: 'a@example.com', password: 'secret' })).rejects.toThrow('auth.useModel(User)')
  })

  it('surfaces as a server error on the login route rather than a silent 401', async () => {
    const app = new Application({ auth: { autoCsrf: false } })
    app.router.post('/login', [LoginController, 'store'])
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/login', { method: 'POST' }))
    expect(response.status).toBe(500)
  })

  it('still treats an anonymous request as unauthenticated, without auth options', async () => {
    const { createSessionMiddleware } = await import('../../src/http/middleware/session')
    const app = new Application()
    app.use('*', createSessionMiddleware())
    app.use('/admin', requireAuthenticated())
    app.router.get('/admin', () => ({ secret: true }))
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/admin'))
    expect(response.status).toBe(401)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('still treats an anonymous request as unauthenticated, with auth options', async () => {
    // With `auth`, the context is attached by AuthServiceProvider at boot, so
    // the guard goes on after it through the boot callback.
    const app = new Application({
      auth: {},
      boot: (hono) => {
        hono.use('/admin', requireAuthenticated({ redirectTo: '/login' }))
      },
    })
    app.router.get('/admin', () => ({ secret: true }))
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/admin'))
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login')
  })
})

/** What an OAuth callback has in hand: a record, not an `Authenticatable` implementation. */
type PlainUser = { id: unknown; email?: string; getAuthIdentifier?: () => unknown; getAuthPassword?: () => null }

describe('login() on an app with no user provider', () => {
  it('puts the record\'s own identifier in the session', async () => {
    const app = new Application({ auth: {} })
    const session = fakeSession()
    const guard = app.auth.createGuard<PlainUser>('web', { ctx: {} as Context, session, manager: app.auth })

    // The OAuth shape: the callback already holds the user, so nothing has to
    // look it up by credentials.
    await guard.login({ id: 42, email: 'a@example.com' })

    expect(session.get<number>('auth:user_id')).toBe(42)
    expect(await guard.user()).toMatchObject({ id: 42 })
  })

  it('reads an Authenticatable through getAuthIdentifier()', async () => {
    const app = new Application({ auth: {} })
    const session = fakeSession()
    const guard = app.auth.createGuard<PlainUser>('web', { ctx: {} as Context, session, manager: app.auth })

    await guard.login({ id: 'ignored', getAuthIdentifier: () => 'uuid-1', getAuthPassword: () => null })

    expect(session.get<string>('auth:user_id')).toBe('uuid-1')
  })

  it('still cannot load that user back on the next request', async () => {
    // retrieveById answers null with nothing to load from, so an OAuth-only app
    // still registers a provider for the session to resolve after the redirect.
    const app = new Application({ auth: {} })
    const session = fakeSession()
    await app.auth.createGuard<PlainUser>('web', { ctx: {} as Context, session, manager: app.auth }).login({ id: 42 })

    const next = app.auth.createGuard<PlainUser>('web', { ctx: {} as Context, session, manager: app.auth })
    expect(await next.user()).toBeNull()
  })
})

describe('the boot-time warning for auth without a user provider', () => {
  const warnSpy = spyOn(console, 'warn')
  afterEach(() => warnSpy.mockClear())

  const warnings = () => warnSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('user provider'))

  it('fires when createApp() received auth and nothing registered "users"', async () => {
    const app = new Application({ auth: {} })
    await app.boot()

    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain('auth.useModel(User)')
  })

  it('stays quiet once a provider is registered, whichever way', async () => {
    const withModel = new Application({ auth: {} })
    withModel.auth.useModel({} as never)
    await withModel.boot()

    const withProvider = new Application({ auth: {} })
    withProvider.auth.registerProvider('users', () => ({
      retrieveById: async () => null,
      retrieveByCredentials: async () => null,
      validateCredentials: async () => false,
      getId: () => 1,
    }))
    await withProvider.boot()

    expect(warnings()).toHaveLength(0)
  })

  it('stays quiet for a token-only app', async () => {
    const app = new Application({ auth: {} })
    app.auth.useTokens({ verify: async () => null } as never, { provider: 'accounts' })
    await app.boot()

    expect(warnings()).toHaveLength(0)
  })

  it('stays quiet when the app mounts its own sessions', async () => {
    const app = new Application({ auth: { autoSession: false } })
    await app.boot()

    expect(warnings()).toHaveLength(0)
  })

  it('stays quiet for an app that never asked for auth', async () => {
    const app = new Application()
    await app.boot()

    expect(warnings()).toHaveLength(0)
  })
})
