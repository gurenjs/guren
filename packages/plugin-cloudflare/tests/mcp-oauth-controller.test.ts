import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { z } from 'zod'
import {
  createApp,
  createCsrfMiddleware,
  createSessionMiddleware,
  generateAppKey,
  MemorySessionStore,
  type Application,
  type Router,
} from '@guren/core'
// Through the *published subpath*, not `../src/env`: the template resolves
// `@guren/plugin-cloudflare/env` to `dist/`, and the holder is module state, so
// capturing into the source copy would fill a holder nothing reads.
import { captureWorkersEnv, resetWorkersEnv } from '@guren/plugin-cloudflare/env'

import { registerMcpOAuthRoutes } from '../templates/mcp-oauth/routes/mcp-oauth'

/**
 * The scaffolded consent flow, exercised as a running application. The template
 * tests next door are substring matches over the source; none would notice the
 * intersection filtering the wrong way round, a forged CSRF token accepted, or
 * `parseBody({ all: true })` losing checkboxes through the real middleware stack.
 * Imported **directly**, not copied: the file under `templates/` is what gets scaffolded.
 */

/** The provider calls the controller makes, recorded and answerable per test. */
interface ProviderCalls {
  completeAuthorization: Array<Record<string, unknown>>
  parseAuthRequest: Request[]
}

let calls: ProviderCalls
let parseAuthRequestThrows: boolean

/**
 * A stand-in for `env.OAUTH_PROVIDER`, with only the three methods the
 * controller touches. `parseAuthRequest` reads the query the way the real one
 * does, which is what makes the POST path's "re-parse rather than trust a hidden
 * field" behaviour observable at all.
 */
const fakeProvider = {
  async parseAuthRequest(request: Request): Promise<Record<string, unknown>> {
    calls.parseAuthRequest.push(request)
    if (parseAuthRequestThrows) {
      throw new Error('invalid_request: unregistered redirect_uri')
    }
    const params = new URL(request.url).searchParams
    return {
      responseType: 'code',
      clientId: params.get('client_id') ?? '',
      redirectUri: params.get('redirect_uri') ?? '',
      scope: (params.get('scope') ?? '').split(' ').filter(Boolean),
      state: params.get('state') ?? '',
    }
  },
  async lookupClient(clientId: string): Promise<Record<string, unknown> | null> {
    return { clientId, clientName: 'Agent <Client>', redirectUris: ['https://client.test/cb'] }
  },
  async completeAuthorization(options: Record<string, unknown>): Promise<{ redirectTo: string }> {
    calls.completeAuthorization.push(options)
    return { redirectTo: 'https://client.test/cb?code=abc' }
  },
}

function registerRoutes(router: Router): void {
  registerMcpOAuthRoutes(router)

  router
    .get('/posts', () => Response.json({ posts: [] }))
    .name('posts.index')
    .agent({ description: 'List posts' })
  router
    .post('/posts', { body: z.object({ title: z.string() }) }, () => Response.json({ ok: true }))
    .name('posts.store')
    .agent({ description: 'Create a post' })
  router
    .delete('/posts/:id', () => Response.json({ ok: true }))
    .name('posts.destroy')
    .agent({ description: 'Delete a post' })
}

const AUTHORIZE_QUERY =
  'client_id=cli_1&redirect_uri=https%3A%2F%2Fclient.test%2Fcb&response_type=code&state=s1'
    + '&scope=tool%3Aposts.index+tool%3Aposts.store'

let app: Application
let previousTesting: string | undefined
let previousAppKey: string | undefined

/**
 * `X-Testing-User` is how `attachAuthContext` authenticates without a real
 * session, honoured only while `GUREN_TESTING` is set.
 */
function asUser(id: string | number | undefined): Record<string, string> {
  return id === undefined ? {} : { 'X-Testing-User': JSON.stringify({ id, __authId: id }) }
}

async function get(query: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://localhost/oauth/authorize?${query}`, { headers }))
}

/** The `_token` value and session cookie a real browser would carry back. */
async function consentSession(): Promise<{ token: string; cookie: string }> {
  const response = await get(AUTHORIZE_QUERY, asUser(7))
  const html = await response.text()
  const token = /name="_token" value="([^"]+)"/.exec(html)?.[1]
  if (!token) {
    throw new Error(`no CSRF token in the consent screen:\n${html.slice(0, 400)}`)
  }
  return { token, cookie: response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') }
}

async function post(
  fields: Array<[string, string]>,
  options: { cookie?: string; user?: string | number } = {},
): Promise<Response> {
  const body = new URLSearchParams()
  for (const [key, value] of fields) body.append(key, value)

  return app.fetch(
    new Request('http://localhost/oauth/authorize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...asUser(options.user ?? 7),
      },
      body: body.toString(),
    }),
  )
}

describe('scaffolded McpOAuthController', () => {
  beforeAll(async () => {
    previousTesting = process.env.GUREN_TESTING
    previousAppKey = process.env.APP_KEY
    process.env.GUREN_TESTING = '1'
    process.env.APP_KEY ??= generateAppKey()

    app = createApp({ routes: registerRoutes })
    // `'*'`, because `use()` takes a path first — and no `secret` option:
    // `SessionOptions` has none, so one passed here would be silently ignored.
    app.use('*', createSessionMiddleware({ store: new MemorySessionStore() }))
    app.use('*', createCsrfMiddleware())
    await app.boot()

    // What `OAuthProvider` injects before either handler runs.
    resetWorkersEnv()
    captureWorkersEnv({ OAUTH_PROVIDER: fakeProvider })
  })

  afterAll(() => {
    resetWorkersEnv()
    if (previousTesting === undefined) delete process.env.GUREN_TESTING
    else process.env.GUREN_TESTING = previousTesting
    if (previousAppKey === undefined) delete process.env.APP_KEY
    else process.env.APP_KEY = previousAppKey
  })

  beforeEach(() => {
    calls = { completeAuthorization: [], parseAuthRequest: [] }
    parseAuthRequestThrows = false
  })

  describe('authentication', () => {
    test('should redirect an unauthenticated GET to the login path', async () => {
      const response = await get(AUTHORIZE_QUERY)

      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toStartWith('/login?redirectTo=')
      // …carrying the authorize request, so the visitor lands back here.
      expect(decodeURIComponent(response.headers.get('Location') ?? '')).toContain('client_id=cli_1')
    })

    test('should redirect an unauthenticated POST to the login path', async () => {
      const { token, cookie } = await consentSession()

      const response = await app.fetch(
        new Request('http://localhost/oauth/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
          body: new URLSearchParams({ _token: token, authorize_query: AUTHORIZE_QUERY }).toString(),
        }),
      )

      // 303, not 302: a redirect out of a POST is See Other, so the browser
      // follows it with a GET rather than re-posting the form.
      expect(response.status).toBe(303)
      expect(response.headers.get('Location')).toStartWith('/login?')
      expect(calls.completeAuthorization).toHaveLength(0)
    })
  })

  describe('consent screen', () => {
    test('should render only the tools the requested scopes expand to', async () => {
      const html = await (await get(AUTHORIZE_QUERY, asUser(7))).text()

      expect(html).toContain('value="tool:posts.index"')
      expect(html).toContain('value="tool:posts.store"')
      // Not requested, so not offered — even though the app serves it.
      expect(html).not.toContain('value="tool:posts.destroy"')
    })

    test('should tick read-only tools and leave writes unticked', async () => {
      const html = await (await get(AUTHORIZE_QUERY, asUser(7))).text()

      expect(html).toContain('value="tool:posts.index" checked')
      // The write is rendered and *not* ticked. Asserted as "present, without
      // `checked`" rather than by matching the tag's closing punctuation: how a
      // renderer spells a void element is its business, and pinning that would
      // test the renderer instead of the default.
      expect(html).toContain('value="tool:posts.store"')
      expect(html).not.toContain('value="tool:posts.store" checked')
    })

    test('should escape a client name rather than render it as markup', async () => {
      const html = await (await get(AUTHORIZE_QUERY, asUser(7))).text()

      expect(html).toContain('Agent &lt;Client&gt;')
      expect(html).not.toContain('Agent <Client>')
    })

    test('should say so when the request expands to nothing grantable', async () => {
      const html = await (
        await get('client_id=cli_1&redirect_uri=x&response_type=code&scope=tool%3Anope', asUser(7))
      ).text()

      expect(html).toContain('no tools it can be granted')
      expect(html).not.toContain('type="checkbox"')
    })
  })

  describe('granting', () => {
    test('should grant exactly the ticked scopes, all of them', async () => {
      const { token, cookie } = await consentSession()

      const response = await post(
        [
          ['_token', token],
          ['authorize_query', AUTHORIZE_QUERY],
          ['scope', 'tool:posts.index'],
          ['scope', 'tool:posts.store'],
        ],
        { cookie },
      )

      expect(response.status).toBe(303)
      expect(response.headers.get('Location')).toBe('https://client.test/cb?code=abc')
      // Both, not just the last: the whole point of parseBody({ all: true }),
      // through the real CSRF middleware that already parsed this body.
      expect(calls.completeAuthorization[0]?.scope).toEqual(['tool:posts.index', 'tool:posts.store'])
    })

    /**
     * The security property of the POST path: a form is user input however it
     * arrived, so a submitted scope the client never requested must be dropped,
     * not merely unrendered on a screen the submitter did not have to use.
     */
    test('should drop a submitted scope outside the offered set', async () => {
      const { token, cookie } = await consentSession()

      await post(
        [
          ['_token', token],
          ['authorize_query', AUTHORIZE_QUERY],
          ['scope', 'tool:posts.index'],
          // Never requested by this client, and destructive.
          ['scope', 'tool:posts.destroy'],
          // Not a tool at all.
          ['scope', 'tools:*'],
          // The bare name, which the scope grammar would ignore anyway.
          ['scope', 'posts.store'],
        ],
        { cookie },
      )

      expect(calls.completeAuthorization[0]?.scope).toEqual(['tool:posts.index'])
    })

    test('should store the app-typed user id and the granted scopes in props', async () => {
      const { token, cookie } = await consentSession()

      await post(
        [['_token', token], ['authorize_query', AUTHORIZE_QUERY], ['scope', 'tool:posts.index']],
        { cookie },
      )

      const options = calls.completeAuthorization[0]!
      expect(options.props).toEqual({ userId: 7, scopes: ['tool:posts.index'] })
      // The provider's own identifier is a string; props keeps the app's type.
      expect(options.userId).toBe('7')
      expect(options.metadata).toHaveProperty('grantedAt')
    })

    test('should grant nothing when nothing was ticked', async () => {
      const { token, cookie } = await consentSession()

      await post([['_token', token], ['authorize_query', AUTHORIZE_QUERY]], { cookie })

      expect(calls.completeAuthorization[0]?.scope).toEqual([])
    })

    /**
     * The hidden field decides *which* authorize request this is and nothing
     * more: the query goes back to `parseAuthRequest`, which re-validates the
     * client and its redirect URI, so a tampered field cannot widen a grant —
     * the offered set is recomputed from what came back.
     */
    test('should re-parse the authorize query rather than trust it', async () => {
      const { token, cookie } = await consentSession()

      await post(
        [
          ['_token', token],
          // Only posts.destroy requested this time.
          ['authorize_query', 'client_id=cli_1&redirect_uri=x&response_type=code&scope=tool%3Aposts.destroy'],
          ['scope', 'tool:posts.index'],
        ],
        { cookie },
      )

      expect(calls.parseAuthRequest.length).toBeGreaterThan(0)
      // posts.index was ticked but is outside the re-parsed request.
      expect(calls.completeAuthorization[0]?.scope).toEqual([])
    })
  })

  describe('CSRF', () => {
    test('should reject a POST carrying no token', async () => {
      const { cookie } = await consentSession()

      const response = await post(
        [['authorize_query', AUTHORIZE_QUERY], ['scope', 'tool:posts.index']],
        { cookie },
      )

      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(calls.completeAuthorization).toHaveLength(0)
    })

    test('should reject a POST carrying a forged token', async () => {
      const { cookie } = await consentSession()

      const response = await post(
        [
          ['_token', 'not-a-real-token'],
          ['authorize_query', AUTHORIZE_QUERY],
          ['scope', 'tool:posts.index'],
        ],
        { cookie },
      )

      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(calls.completeAuthorization).toHaveLength(0)
    })

    /**
     * The defensive half: the controller must refuse a bad token *itself*, not
     * only because a global middleware happened to be mounted. An app with
     * `autoSession: false` may not have it, and the rendered token looks
     * convincing either way, so the screen would look protected regardless.
     */
    test('should still refuse a forged token with no CSRF middleware mounted', async () => {
      const bare = createApp({ routes: registerRoutes })
      // Session, but deliberately no CSRF middleware — the whole point.
      bare.use('*', createSessionMiddleware({ store: new MemorySessionStore() }))
      await bare.boot()

      const response = await bare.fetch(
        new Request('http://localhost/oauth/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...asUser(7) },
          body: new URLSearchParams({
            _token: 'forged',
            authorize_query: AUTHORIZE_QUERY,
            scope: 'tool:posts.store',
          }).toString(),
        }),
      )

      expect(response.status).toBe(419)
      expect(calls.completeAuthorization).toHaveLength(0)
    })
  })

  describe('malformed authorize requests', () => {
    test('should answer GET with a clean 400 page rather than a stack trace', async () => {
      parseAuthRequestThrows = true

      const response = await get(AUTHORIZE_QUERY, asUser(7))
      const html = await response.text()

      expect(response.status).toBe(400)
      expect(html).toContain('not valid')
      // Neither the provider's message nor a stack: both are derived from
      // attacker-controllable query parameters.
      expect(html).not.toContain('unregistered redirect_uri')
      // A stack frame, spelled as one: a bare `'at '` matches the word
      // "th`at `" in the page's own advice.
      expect(html).not.toMatch(/\n\s+at\s/u)
      expect(html).not.toContain('Error:')
    })

    test('should answer POST with a clean 400 page and grant nothing', async () => {
      const { token, cookie } = await consentSession()
      parseAuthRequestThrows = true

      const response = await post(
        [['_token', token], ['authorize_query', 'garbage'], ['scope', 'tool:posts.index']],
        { cookie },
      )

      expect(response.status).toBe(400)
      expect(calls.completeAuthorization).toHaveLength(0)
    })
  })
})
