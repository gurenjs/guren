/**
 * The principal seam in the auth context (RFC 0017 §2): a request the
 * invocation pipeline installed a principal on authenticates inside the
 * application, through the same surface a session or a token does.
 * Every case drives a real `Application` through `app.fetch` with a `Request`
 * built here, because the seam is keyed on **object identity** — anything
 * between installation and the auth context that rebuilt the request breaks it
 * silently, which a unit test of the map alone cannot see. The copy case below
 * is no curiosity either: a copy is what a caller holding the bytes builds.
 */
process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, test, expect } from 'bun:test'

import { createApp } from '../../src/http/Application'
import { Gate } from '../../src/authorization/Gate'
import { requireAuthenticated } from '../../src/http/middleware/auth'
import { getAuthContext } from '../../src/auth/context'
import { installAgentPrincipal } from '../../src/internal/agent-principal'
import { MemorySessionStore } from '../../src/http/middleware/session'
import { MemoryApiTokenStore } from '../../src/auth/api-token'
import { AuthServiceProvider } from '../../src/providers/AuthServiceProvider'
import type { Application } from '../../src/http/Application'
import type { Router } from '../../src/mvc/Router'
import type { AgentPrincipal } from '../../src/agent/events'

const SERVICE: AgentPrincipal = { kind: 'service', id: 'agent:triager:1' }
const PERSON: AgentPrincipal = { kind: 'user', id: 42 }

function registerRoutes(router: Router): void {
  router.middleware(requireAuthenticated()).group((auth) => {
    auth.get('/private', async (c) => {
      const user = await getAuthContext(c)?.user()
      return Response.json({ user })
    })
  })
  // Unguarded, so the *guard selection* is what the case observes rather than
  // a 401 that could come from anywhere.
  router.get('/whoami', async (c) => {
    const context = getAuthContext(c)
    return Response.json({
      viaDefault: await context?.user(),
      viaWeb: await context?.guard('web').user(),
      id: await context?.id(),
    })
  })
  router.get('/gate', async (c) => {
    const gate = new Gate()
    gate.define('read-posts', (user) => (user as { id: unknown } | null)?.id === 'agent:triager:1')
    // Through `resolveUser`, which is how `authorizeMiddleware` and every
    // policy reach the request's user: the auth context's answer.
    const allowed = await gate.forUser(await gate.resolveUser(c)).allows('read-posts')
    return Response.json({ allowed })
  })
}

function seamRequest(path: string, principal: AgentPrincipal = SERVICE): Request {
  return installAgentPrincipal(new Request(`http://localhost${path}`), {
    principal,
    abilities: ['tools:*'],
  })
}

/** The fallback path: no `auth` options, so `Application` attaches the context. */
async function fallbackApp(): Promise<Application> {
  const app = createApp({ routes: registerRoutes })
  await app.boot()
  return app
}

/** The provider path: `AuthServiceProvider` attaches its own auth context. */
async function providerApp(): Promise<Application> {
  const app = createApp({
    routes: registerRoutes,
    providers: [AuthServiceProvider],
    auth: { sessionOptions: { store: new MemorySessionStore() } },
  })
  await app.boot()
  return app
}

// Both attach paths. `AuthServiceProvider` mounts one auth context; the
// `Application` constructor mounts a fallback for apps with no `auth` options.
// They reach the seam through the same `AuthManager.createAuthContext`, and a
// regression in either would leave the other green.
for (const [label, build] of [
  ['the Application fallback auth context', fallbackApp],
  ['AuthServiceProvider', providerApp],
] as const) {
  describe(`the installed principal, through ${label}`, () => {
    test('should satisfy requireAuthenticated()', async () => {
      const app = await build()
      const response = await app.fetch(seamRequest('/private'))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ user: { id: 'agent:triager:1' } })
    })

    test('should resolve through Controller.auth as a minimal { id } record', async () => {
      const app = await build()
      const body = (await (await app.fetch(seamRequest('/whoami'))).json()) as Record<string, unknown>
      expect(body.viaDefault).toEqual({ id: 'agent:triager:1' })
      expect(body.id).toBe('agent:triager:1')
    })

    test('should leave an explicit guard("web") on the session guard', async () => {
      const app = await build()
      const body = (await (await app.fetch(seamRequest('/whoami'))).json()) as Record<string, unknown>
      // Asking for a named guard is asking *that* guard the question: the
      // session guard has no session here, so it answers null.
      expect(body.viaWeb).toBeNull()
    })

    test('should reach a Gate policy as the principal', async () => {
      const app = await build()
      const body = (await (await app.fetch(seamRequest('/gate'))).json()) as { allowed: boolean }
      expect(body.allowed).toBe(true)
    })

    test('should carry a kind: user principal by its own id', async () => {
      const app = await build()
      const body = (await (await app.fetch(seamRequest('/whoami', PERSON))).json()) as Record<string, unknown>
      expect(body.viaDefault).toEqual({ id: 42 })
    })

    /**
     * The security property, stated as a test rather than as a comment: a
     * request *copied* from a marked one is a different object, so it carries
     * nothing. `new Request(req)` is what a caller who has the bytes can build.
     */
    test('should not authenticate a request rebuilt from a marked one', async () => {
      const app = await build()
      const marked = seamRequest('/private')
      const response = await app.fetch(new Request(marked))
      expect(response.status).toBe(401)
    })

    test('should not authenticate an ordinary unmarked request', async () => {
      const app = await build()
      const response = await app.fetch(new Request('http://localhost/private'))
      expect(response.status).toBe(401)
    })
  })
}

describe('the agent principal guard and the guard registry', () => {
  test('should not appear in guardNames()', async () => {
    const app = await providerApp()
    expect(app.auth.guardNames()).not.toContain('guren.agent-principal')
  })

  test('should still resolve a bearer request to the token guard', async () => {
    // The seam sits in front of the bearer check, but only for requests that
    // carry it: an ordinary bearer request must be unable to tell this release
    // from the last.
    const app = await providerApp()
    app.auth.useTokens(new MemoryApiTokenStore())

    const bearer = { req: { raw: new Request('http://localhost/x'), header: () => 'Bearer abc' } }
    expect(app.auth.resolveGuardName(bearer as never)).toBe('token')

    // And a seam-marked request wins over the bearer check, which is the order
    // the composite rule states: the framework's own identity beats a header.
    const marked = {
      req: { raw: seamRequest('/x'), header: () => 'Bearer abc' },
    }
    expect(app.auth.resolveGuardName(marked as never)).toBe('guren.agent-principal')
  })
})
