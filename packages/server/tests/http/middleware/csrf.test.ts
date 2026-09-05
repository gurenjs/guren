process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { afterEach, describe, expect, it } from 'bun:test'
import { Hono, type Context } from 'hono'
import { MCP_ENDPOINT_PATH } from '../../../src/mcp/endpoint'
import {
  createCsrfMiddleware,
  CSRF_FORM_FIELD,
  CSRF_HEADER_NAME,
  csrfField,
  getCsrfToken,
  verifyCsrfToken,
} from '../../../src/http/middleware/csrf'
import {
  createSessionMiddleware,
  getSessionFromContext,
  MemorySessionStore,
} from '../../../src/http/middleware/session'
import { installAgentPrincipal } from '../../../src/internal/agent-principal'

function createTestApp(csrfOptions?: Parameters<typeof createCsrfMiddleware>[0]) {
  const app = new Hono()
  app.use(createSessionMiddleware())
  app.use(createCsrfMiddleware(csrfOptions))
  return app
}

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
})

/**
 * A single `name=value` pair from the response, for tests that control which XSRF
 * cookie the server sees: `extractCookie` joins every Set-Cookie, so a logged-in
 * response carries a session XSRF token that shadows any planted one.
 */
function pickCookie(res: Response, name: string): string {
  const cookies = res.headers.getSetCookie?.() ?? []
  const match = cookies.find((cookie) => cookie.startsWith(`${name}=`))
  return match ? match.split(';')[0] : ''
}

function extractCookie(res: Response): string {
  // Joined rather than picked, so a session cookie beside XSRF-TOKEN survives.
  const cookies = res.headers.getSetCookie?.() ?? []
  if (cookies.length > 0) {
    return cookies.map((c) => c.split(';')[0]).join('; ')
  }
  return res.headers.get('set-cookie')?.split(';')[0] ?? ''
}

describe('getCsrfToken', () => {
  it('returns a stable token across calls within a request', async () => {
    const app = createTestApp()
    let token1: string | undefined
    let token2: string | undefined

    app.get('/token', (c) => {
      token1 = getCsrfToken(c)
      token2 = getCsrfToken(c)
      return c.json({ token: token1 })
    })

    await app.request('/token')

    expect(token1).toBeDefined()
    expect(token1).toBe(token2)
  })

  it('works without session middleware (stateless double-submit)', async () => {
    const app = new Hono()
    app.use(createCsrfMiddleware())

    app.get('/token', (c) => c.json({ token: getCsrfToken(c) }))
    app.post('/submit', (c) => c.text('ok'))

    const res = await app.request('/token')
    const { token } = (await res.json()) as { token: string }
    expect(token).toContain('.')

    const cookie = extractCookie(res)
    const post = await app.request('/submit', {
      method: 'POST',
      headers: { Cookie: cookie, [CSRF_HEADER_NAME]: token },
    })

    expect(post.status).toBe(200)
  })
})

describe('csrfField', () => {
  it('generates hidden input with token', async () => {
    const app = createTestApp()

    app.get('/form', (c) => {
      const field = csrfField(c)
      return c.html(`<form>${field}</form>`)
    })

    const res = await app.request('/form')
    const html = await res.text()

    expect(html).toContain('<input type="hidden" name="_token"')
    expect(html).toMatch(/value="[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"/)
  })
})

describe('verifyCsrfToken', () => {
  it('returns true for a signed token matching the cookie', async () => {
    const app = createTestApp()
    let issuedToken: string | undefined
    let result: boolean | undefined

    app.get('/issue', (c) => {
      issuedToken = getCsrfToken(c)
      return c.text('ok')
    })
    app.get('/verify', (c) => {
      result = verifyCsrfToken(c, issuedToken)
      return c.text('ok')
    })

    const res = await app.request('/issue')
    await app.request('/verify', { headers: { Cookie: extractCookie(res) } })

    expect(result).toBe(true)
  })

  it('returns false for mismatched token', async () => {
    const app = createTestApp()
    let result: boolean | undefined

    app.get('/test', (c) => {
      getCsrfToken(c)
      result = verifyCsrfToken(c, 'wrong-token')
      return c.text('ok')
    })

    await app.request('/test')

    expect(result).toBe(false)
  })

  it('returns false for undefined token', async () => {
    const app = createTestApp()
    let result: boolean | undefined

    app.get('/test', (c) => {
      getCsrfToken(c)
      result = verifyCsrfToken(c, undefined)
      return c.text('ok')
    })

    await app.request('/test')

    expect(result).toBe(false)
  })
})

describe('createCsrfMiddleware', () => {
  it('allows GET requests without token', async () => {
    const app = createTestApp()

    app.get('/page', (c) => c.text('page content'))

    const res = await app.request('/page')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('page content')
  })

  it('rejects POST requests without token', async () => {
    const app = createTestApp()

    app.post('/submit', (c) => c.text('submitted'))

    const res = await app.request('/submit', { method: 'POST' })

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toEqual({ message: 'CSRF token mismatch' })
  })

  it('accepts POST requests with valid token in form field', async () => {
    const app = createTestApp()
    let token: string | undefined

    app.get('/form', (c) => {
      token = getCsrfToken(c)
      return c.text('form')
    })

    app.post('/submit', (c) => c.text('submitted'))

    const getRes = await app.request('/form')
    const cookie = extractCookie(getRes)

    const formData = new URLSearchParams()
    formData.set(CSRF_FORM_FIELD, token!)

    const postRes = await app.request('/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
      },
      body: formData.toString(),
    })

    expect(postRes.status).toBe(200)
    expect(await postRes.text()).toBe('submitted')
  })

  it('accepts POST requests with valid token in header', async () => {
    const app = createTestApp()
    let token: string | undefined

    app.get('/api/token', (c) => {
      token = getCsrfToken(c)
      return c.json({ token })
    })

    app.post('/api/data', (c) => c.json({ success: true }))

    const getRes = await app.request('/api/token')
    const cookie = extractCookie(getRes)

    const postRes = await app.request('/api/data', {
      method: 'POST',
      headers: {
        [CSRF_HEADER_NAME]: token!,
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ data: 'test' }),
    })

    expect(postRes.status).toBe(200)
    const body = await postRes.json()
    expect(body).toEqual({ success: true })
  })

  it('accepts POST requests with valid token in JSON body', async () => {
    const app = createTestApp()
    let token: string | undefined

    app.get('/api/token', (c) => {
      token = getCsrfToken(c)
      return c.json({ token })
    })

    app.post('/api/data', (c) => c.json({ success: true }))

    const getRes = await app.request('/api/token')
    const cookie = extractCookie(getRes)

    const postRes = await app.request('/api/data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ data: 'test', [CSRF_FORM_FIELD]: token }),
    })

    expect(postRes.status).toBe(200)
  })

  it('protects PUT, PATCH, and DELETE methods', async () => {
    const app = createTestApp()

    app.put('/resource', (c) => c.text('put'))
    app.patch('/resource', (c) => c.text('patch'))
    app.delete('/resource', (c) => c.text('delete'))

    const putRes = await app.request('/resource', { method: 'PUT' })
    expect(putRes.status).toBe(403)

    const patchRes = await app.request('/resource', { method: 'PATCH' })
    expect(patchRes.status).toBe(403)

    const deleteRes = await app.request('/resource', { method: 'DELETE' })
    expect(deleteRes.status).toBe(403)
  })

  it('allows QUERY requests without token by default (RFC 10008 safe method)', async () => {
    const app = createTestApp()

    app.on('QUERY', '/search', (c) => c.json({ ok: true }))

    const res = await app.request('/search', {
      method: 'QUERY',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: 'hello' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('protects QUERY when opted in via the methods option', async () => {
    const app = createTestApp({
      methods: ['POST', 'PUT', 'PATCH', 'DELETE', 'QUERY'],
    })
    let token: string | undefined

    app.get('/api/token', (c) => {
      token = getCsrfToken(c)
      return c.json({ token })
    })
    app.on('QUERY', '/search', (c) => c.json({ ok: true }))

    const tokenless = await app.request('/search', {
      method: 'QUERY',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: 'hello' }),
    })
    expect(tokenless.status).toBe(403)

    const getRes = await app.request('/api/token')
    const cookie = extractCookie(getRes)

    const withToken = await app.request('/search', {
      method: 'QUERY',
      headers: {
        [CSRF_HEADER_NAME]: token!,
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ q: 'hello' }),
    })
    expect(withToken.status).toBe(200)
    expect(await withToken.json()).toEqual({ ok: true })
  })

  it('excludes specified paths from protection', async () => {
    const app = createTestApp({
      exclude: ['/api/webhooks/*', '/health'],
    })

    app.post('/api/webhooks/stripe', (c) => c.text('webhook received'))
    app.post('/api/webhooks/github', (c) => c.text('webhook received'))
    app.post('/health', (c) => c.text('healthy'))
    app.post('/api/data', (c) => c.text('data'))

    const webhookRes = await app.request('/api/webhooks/stripe', { method: 'POST' })
    expect(webhookRes.status).toBe(200)

    const githubRes = await app.request('/api/webhooks/github', { method: 'POST' })
    expect(githubRes.status).toBe(200)

    const healthRes = await app.request('/health', { method: 'POST' })
    expect(healthRes.status).toBe(200)

    const dataRes = await app.request('/api/data', { method: 'POST' })
    expect(dataRes.status).toBe(403)
  })

  it('exempts the MCP endpoint while it is mounted', async () => {
    process.env.GUREN_MCP = '1'

    const app = createTestApp()
    app.post(MCP_ENDPOINT_PATH, (c) => c.text('jsonrpc'))
    app.post('/_guren/other', (c) => c.text('other'))

    // MCP clients POST JSON-RPC without ever fetching a token.
    const mcpRes = await app.request(MCP_ENDPOINT_PATH, { method: 'POST' })
    expect(mcpRes.status).toBe(200)

    // The exemption is the endpoint itself, not the whole namespace.
    const otherRes = await app.request('/_guren/other', { method: 'POST' })
    expect(otherRes.status).toBe(403)
  })

  it('exempts a declared cookieless-auth path, and only by exact match', async () => {
    const declared = new Set(['/mcp'])
    const app = new Hono()
    app.use(createSessionMiddleware())
    app.use(createCsrfMiddleware(undefined, () => declared))
    app.post('/mcp', (c) => c.text('jsonrpc'))
    app.post('/mcp/tools', (c) => c.text('subpath'))
    app.post('/comments', (c) => c.text('ordinary'))

    expect((await app.request('/mcp', { method: 'POST' })).status).toBe(200)
    // A declared path is one route, so no prefix or pattern is implied.
    expect((await app.request('/mcp/tools', { method: 'POST' })).status).toBe(403)
    expect((await app.request('/comments', { method: 'POST' })).status).toBe(403)
  })

  it('reads declared paths per request, not at middleware creation', async () => {
    const declared = new Set<string>()
    const app = new Hono()
    app.use(createSessionMiddleware())
    app.use(createCsrfMiddleware(undefined, () => declared))
    app.post('/mcp', (c) => c.text('jsonrpc'))

    expect((await app.request('/mcp', { method: 'POST' })).status).toBe(403)

    // The declaring endpoint mounts at boot, after this middleware was created.
    declared.add('/mcp')
    expect((await app.request('/mcp', { method: 'POST' })).status).toBe(200)
  })

  it('protects the MCP path when the endpoint is not mounted', async () => {
    delete process.env.GUREN_MCP

    const app = createTestApp()
    app.post(MCP_ENDPOINT_PATH, (c) => c.text('jsonrpc'))

    const res = await app.request(MCP_ENDPOINT_PATH, { method: 'POST' })
    expect(res.status).toBe(403)
  })

  it('protects the MCP path in production', async () => {
    process.env.GUREN_MCP = '1'
    process.env.NODE_ENV = 'production'

    const app = createTestApp()
    app.post(MCP_ENDPOINT_PATH, (c) => c.text('jsonrpc'))

    const res = await app.request(MCP_ENDPOINT_PATH, { method: 'POST' })
    expect(res.status).toBe(403)
  })

  it('uses custom error handler when provided', async () => {
    const app = createTestApp({
      onError: (_ctx) =>
        new Response('Custom CSRF error', {
          status: 419,
          headers: { 'X-CSRF-Error': 'true' },
        }),
    })

    app.post('/submit', (c) => c.text('submitted'))

    const res = await app.request('/submit', { method: 'POST' })

    expect(res.status).toBe(419)
    expect(await res.text()).toBe('Custom CSRF error')
    expect(res.headers.get('X-CSRF-Error')).toBe('true')
  })

  it('allows customizing protected methods', async () => {
    const app = createTestApp({
      methods: ['POST'],
    })

    app.post('/data', (c) => c.text('post'))
    app.put('/data', (c) => c.text('put'))
    app.delete('/data', (c) => c.text('delete'))

    const postRes = await app.request('/data', { method: 'POST' })
    expect(postRes.status).toBe(403)

    const putRes = await app.request('/data', { method: 'PUT' })
    expect(putRes.status).toBe(200)

    const deleteRes = await app.request('/data', { method: 'DELETE' })
    expect(deleteRes.status).toBe(200)
  })

  it('rejects requests with wrong token', async () => {
    const app = createTestApp()

    app.get('/form', (c) => {
      getCsrfToken(c)
      return c.text('form')
    })

    app.post('/submit', (c) => c.text('submitted'))

    const getRes = await app.request('/form')
    const cookie = extractCookie(getRes)

    const formData = new URLSearchParams()
    formData.set(CSRF_FORM_FIELD, 'wrong-token-value')

    const postRes = await app.request('/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
      },
      body: formData.toString(),
    })

    expect(postRes.status).toBe(403)
  })

  it('persists token across requests in the same session', async () => {
    const app = createTestApp()
    let token1: string | undefined
    let token2: string | undefined

    app.get('/page1', (c) => {
      token1 = getCsrfToken(c)
      return c.text('page1')
    })

    app.get('/page2', (c) => {
      token2 = getCsrfToken(c)
      return c.text('page2')
    })

    const res1 = await app.request('/page1')
    const cookie = extractCookie(res1)

    await app.request('/page2', {
      headers: { Cookie: cookie },
    })

    expect(token1).toBeDefined()
    expect(token1).toBe(token2)
  })
})

describe('setXsrfCookie append behavior', () => {
  it('preserves cookies set by inner middleware and handlers', async () => {
    const app = createTestApp()

    app.use(async (c, next) => {
      c.header('Set-Cookie', 'locale=ja; Path=/; SameSite=Lax', { append: true })
      await next()
    })

    app.get('/page', (c) => c.text('page content'))

    const res = await app.request('/page')
    const cookies = res.headers.getSetCookie()

    expect(cookies.some((c) => c.startsWith('locale=ja'))).toBe(true)
    expect(cookies.some((c) => c.startsWith('XSRF-TOKEN='))).toBe(true)
  })

  it('preserves cookies on protected methods after a successful mutation', async () => {
    const app = createTestApp()
    let token: string | undefined

    app.get('/form', (c) => {
      token = getCsrfToken(c)
      return c.text('form')
    })

    app.post('/submit', (c) => {
      c.header('Set-Cookie', 'theme=dark; Path=/; SameSite=Lax', { append: true })
      return c.text('submitted')
    })

    const getRes = await app.request('/form')
    const cookie = extractCookie(getRes)

    const postRes = await app.request('/submit', {
      method: 'POST',
      headers: {
        [CSRF_HEADER_NAME]: token!,
        Cookie: cookie,
      },
    })

    expect(postRes.status).toBe(200)
    const cookies = postRes.headers.getSetCookie()
    expect(cookies.some((c) => c.startsWith('theme=dark'))).toBe(true)
    expect(cookies.some((c) => c.startsWith('XSRF-TOKEN='))).toBe(true)
  })
})

describe('stateless double-submit security', () => {
  it('rejects a forged unsigned cookie/header pair', async () => {
    const app = createTestApp()
    app.post('/submit', (c) => c.text('ok'))

    // A sibling-domain attacker can plant a cookie and echo it in the
    // header, but cannot produce a valid app-key signature.
    const forged = 'attacker-value.attacker-signature'
    const res = await app.request('/submit', {
      method: 'POST',
      headers: {
        Cookie: `XSRF-TOKEN=${encodeURIComponent(forged)}`,
        [CSRF_HEADER_NAME]: forged,
      },
    })

    expect(res.status).toBe(403)
  })

  it('rejects a token whose signature was tampered with', async () => {
    const app = createTestApp()
    let token: string | undefined
    app.get('/form', (c) => {
      token = getCsrfToken(c)
      return c.text('ok')
    })
    app.post('/submit', (c) => c.text('ok'))

    await app.request('/form')
    const [value] = token!.split('.')
    const tampered = `${value}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`

    const res = await app.request('/submit', {
      method: 'POST',
      headers: {
        Cookie: `XSRF-TOKEN=${encodeURIComponent(tampered)}`,
        [CSRF_HEADER_NAME]: tampered,
      },
    })

    expect(res.status).toBe(403)
  })

  it('rejects a signed token that does not match the cookie', async () => {
    const app = createTestApp()
    const tokens: string[] = []
    app.get('/form', (c) => {
      tokens.push(getCsrfToken(c))
      return c.text('ok')
    })
    app.post('/submit', (c) => c.text('ok'))

    const first = await app.request('/form')
    await app.request('/form')

    // Two independently minted tokens: use one in the cookie, the other in
    // the header — both validly signed, but not a pair.
    const res = await app.request('/submit', {
      method: 'POST',
      headers: {
        Cookie: extractCookie(first),
        [CSRF_HEADER_NAME]: tokens[1]!,
      },
    })

    expect(res.status).toBe(403)
  })

  it('accepts a legacy session-stored token until the session expires', async () => {
    const app = createTestApp()
    app.get('/legacy', (c) => {
      getSessionFromContext(c)?.set('_csrf_token', 'legacy-hex-token')
      return c.text('ok')
    })
    app.post('/submit', (c) => c.text('ok'))

    const res = await app.request('/legacy')
    const post = await app.request('/submit', {
      method: 'POST',
      headers: {
        Cookie: extractCookie(res),
        [CSRF_HEADER_NAME]: 'legacy-hex-token',
      },
    })

    expect(post.status).toBe(200)
  })

  it('costs zero session store operations for a guest GET + POST roundtrip', async () => {
    const { createSessionMiddleware: makeSession, MemorySessionStore } = await import(
      '../../../src/http/middleware/session'
    )
    const { spyOn } = await import('bun:test')
    const store = new MemorySessionStore()
    const writes = spyOn(store, 'write')
    const touches = spyOn(store, 'touch')

    const app = new Hono()
    app.use(makeSession({ store }))
    app.use(createCsrfMiddleware())
    app.get('/page', (c) => c.json({ token: getCsrfToken(c) }))
    app.post('/submit', (c) => c.text('ok'))

    const res = await app.request('/page')
    const { token } = (await res.json()) as { token: string }

    const post = await app.request('/submit', {
      method: 'POST',
      headers: {
        Cookie: extractCookie(res),
        [CSRF_HEADER_NAME]: token,
      },
    })

    expect(post.status).toBe(200)
    expect(writes).toHaveBeenCalledTimes(0)
    expect(touches).toHaveBeenCalledTimes(0)
    // No session cookie was ever issued — only the XSRF token cookie.
    expect(extractCookie(res)).not.toContain('guren.session=')
  })
})

describe('session-bound tokens (cookie-injection immunity)', () => {
  // A logged-in user: establish a persisted session, then all later
  // requests carry a stable session id the token binds to.
  function createBoundApp() {
    const store = new MemorySessionStore()
    const app = new Hono()
    app.use(createSessionMiddleware({ store }))
    app.use(createCsrfMiddleware())
    app.get('/login', (c) => {
      getSessionFromContext(c)?.set('userId', 1)
      return c.text('ok')
    })
    app.get('/form', (c) => c.json({ token: getCsrfToken(c) }))
    app.post('/submit', (c) => c.text('ok'))
    return app
  }

  async function loginCookie(app: Hono): Promise<string> {
    return extractCookie(await app.request('/login'))
  }

  it('binds the token to the session and accepts a matching submit', async () => {
    const app = createBoundApp()
    const session = await loginCookie(app)

    const formRes = await app.request('/form', { headers: { Cookie: session } })
    const { token } = (await formRes.json()) as { token: string }

    const post = await app.request('/submit', {
      method: 'POST',
      headers: {
        Cookie: [session, extractCookie(formRes)].filter(Boolean).join('; '),
        [CSRF_HEADER_NAME]: token,
      },
    })

    expect(post.status).toBe(200)
  })

  it('rejects an attacker-injected valid token from a different session', async () => {
    const app = createBoundApp()

    // Attacker mints their own legitimately-signed, session-bound token.
    const attackerSession = await loginCookie(app)
    const attackerForm = await app.request('/form', { headers: { Cookie: attackerSession } })
    const { token: attackerToken } = (await attackerForm.json()) as { token: string }
    const attackerXsrf = extractCookie(attackerForm)

    const victimSession = await loginCookie(app)

    // Attacker plants their XSRF cookie + header on the victim's request.
    // The token is bound to the attacker's session id, not the victim's.
    const post = await app.request('/submit', {
      method: 'POST',
      headers: {
        Cookie: [victimSession, attackerXsrf].filter(Boolean).join('; '),
        [CSRF_HEADER_NAME]: attackerToken,
      },
    })

    expect(post.status).toBe(403)
  })

  it('supports cookie:false for session-bound flows (no XSRF cookie needed)', async () => {
    const store = new MemorySessionStore()
    const app = new Hono()
    app.use(createSessionMiddleware({ store }))
    app.use(createCsrfMiddleware({ cookie: false }))
    app.get('/login', (c) => {
      getSessionFromContext(c)?.set('userId', 1)
      return c.text('ok')
    })
    app.get('/form', (c) => c.json({ token: getCsrfToken(c) }))
    app.post('/submit', (c) => c.text('ok'))

    const session = extractCookie(await app.request('/login'))
    const formRes = await app.request('/form', { headers: { Cookie: session } })
    const { token } = (await formRes.json()) as { token: string }

    // No XSRF-TOKEN cookie is issued; the token verifies against the session id.
    expect(extractCookie(formRes)).not.toContain('XSRF-TOKEN=')

    const post = await app.request('/submit', {
      method: 'POST',
      headers: { Cookie: session, [CSRF_HEADER_NAME]: token },
    })

    expect(post.status).toBe(200)
  })
})

describe('mode enforcement between minting and verification', () => {
  // Mirrors what SessionGuard.login() does: rotate the id, then store the
  // user. Testing with a bare set() would miss the regenerate path entirely.
  function logIn(c: Context) {
    const session = getSessionFromContext(c)
    session?.regenerate()
    session?.set('userId', 1)
  }

  function createApp(csrfOptions?: Parameters<typeof createCsrfMiddleware>[0]) {
    const store = new MemorySessionStore()
    const app = new Hono()
    app.use(createSessionMiddleware({ store }))
    app.use(createCsrfMiddleware(csrfOptions))
    app.get('/guest', (c) => c.json({ token: getCsrfToken(c) }))
    app.on(['GET', 'POST'], '/login', (c) => {
      logIn(c)
      return c.text('ok')
    })
    // Shared props or a layout touching the token before the controller logs the
    // user in: the second read must reflect the session that now exists, not the
    // guest answer the first cached.
    app.get('/login-and-render', (c) => {
      const before = getCsrfToken(c)
      logIn(c)
      return c.json({ before, token: getCsrfToken(c) })
    })
    app.post('/logout', (c) => {
      getSessionFromContext(c)?.invalidate()
      return c.text('ok')
    })
    app.post('/exempt-login', (c) => {
      logIn(c)
      return c.text('ok')
    })
    app.post('/submit', (c) => c.text('ok'))
    return app
  }

  function xsrfFrom(res: Response): string {
    const pair = pickCookie(res, 'XSRF-TOKEN')
    return pair ? decodeURIComponent(pair.slice('XSRF-TOKEN='.length)) : ''
  }

  it('rejects a guest token on a request that carries a session', async () => {
    const app = createApp()

    // Anyone can mint a validly-signed guest token just by visiting.
    const guestRes = await app.request('/guest')
    const { token: guestToken } = (await guestRes.json()) as { token: string }
    const guestXsrf = pickCookie(guestRes, 'XSRF-TOKEN')

    // Without these the test could pass for the wrong reason: no planted
    // cookie at all would fail double-submit rather than the mode rule.
    expect(guestXsrf).not.toBe('')
    expect(xsrfFrom(guestRes)).toBe(guestToken)

    // A logged-in victim: only their session cookie is carried over, since the
    // planted XSRF cookie is the attacker's. Sending the victim's own too would
    // fail on the cookie mismatch instead of on the mode rule.
    const victimSession = pickCookie(await app.request('/login'), 'guren.session')
    expect(victimSession).not.toBe('')

    // Double-submit is satisfied (header value === cookie value), but the
    // request has a session to bind to, so the stateless path must be closed.
    const post = await app.request('/submit', {
      method: 'POST',
      headers: {
        Cookie: [victimSession, guestXsrf].join('; '),
        [CSRF_HEADER_NAME]: guestToken,
      },
    })

    expect(post.status).toBe(403)
  })

  it('issues a session-bound token on the response that establishes the session', async () => {
    const app = createApp()

    // The login response has to hand back a token for the session it just
    // created, not the guest token the request came in with.
    const guestRes = await app.request('/guest')
    const { token: guestToken } = (await guestRes.json()) as { token: string }
    const guestCookies = extractCookie(guestRes)

    const loginRes = await app.request('/login', {
      method: 'POST',
      headers: { Cookie: guestCookies, [CSRF_HEADER_NAME]: guestToken },
    })
    expect(loginRes.status).toBe(200)

    const loggedIn = extractCookie(loginRes)
    expect(loggedIn).toContain('guren.session=')
    expect(loggedIn).toContain('XSRF-TOKEN=')

    // The token issued by that same response must work on the next mutation.
    const issued = xsrfFrom(loginRes)
    expect(issued).not.toBe(guestToken)

    const post = await app.request('/submit', {
      method: 'POST',
      headers: { Cookie: loggedIn, [CSRF_HEADER_NAME]: issued },
    })

    expect(post.status).toBe(200)
  })

  it('hands the handler the same token it writes to the cookie', async () => {
    const app = createApp()

    // A handler that logs the user in and then renders the token (a form's hidden
    // `_token`). Handed the token computed before the session existed, the form
    // would carry a guest token against a bound cookie and 403 on submit.
    const res = await app.request('/login-and-render')
    const { before, token: rendered } = (await res.json()) as { before: string; token: string }

    // The pre-login read is the guest answer; re-reading after the login has
    // to move on from it, and land on what the cookie gets.
    expect(rendered).not.toBe(before)
    expect(rendered).toBe(xsrfFrom(res))

    const post = await app.request('/submit', {
      method: 'POST',
      headers: { Cookie: extractCookie(res), [CSRF_HEADER_NAME]: rendered },
    })

    expect(post.status).toBe(200)
  })

  it('refreshes the token on an excluded path that establishes a session', async () => {
    // Exempt endpoints skip verification, but an OAuth callback still logs
    // the user in — so it has to leave with a bound token like any other
    // response, or the user's next mutation is rejected.
    const app = createApp({ exclude: ['/exempt-login'] })

    const res = await app.request('/exempt-login', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(pickCookie(res, 'guren.session')).not.toBe('')

    const issued = xsrfFrom(res)
    expect(issued).not.toBe('')

    const post = await app.request('/submit', {
      method: 'POST',
      headers: { Cookie: extractCookie(res), [CSRF_HEADER_NAME]: issued },
    })

    expect(post.status).toBe(200)
  })

  it('returns the user to guest mode after the session is invalidated', async () => {
    const app = createApp()

    const loginRes = await app.request('/login')
    const logoutRes = await app.request('/logout', {
      method: 'POST',
      headers: { Cookie: extractCookie(loginRes), [CSRF_HEADER_NAME]: xsrfFrom(loginRes) },
    })
    expect(logoutRes.status).toBe(200)

    // The session is gone, so the response must hand back a stateless token
    // that the now-sessionless client can actually use.
    const issued = xsrfFrom(logoutRes)
    expect(issued).not.toBe('')

    const post = await app.request('/submit', {
      method: 'POST',
      headers: {
        Cookie: `XSRF-TOKEN=${encodeURIComponent(issued)}`,
        [CSRF_HEADER_NAME]: issued,
      },
    })

    expect(post.status).toBe(200)
  })
})

describe('cookie-less bearer requests (RFC 0016)', () => {
  function createBearerApp() {
    const store = new MemorySessionStore()
    const app = new Hono()
    app.use(createSessionMiddleware({ store }))
    app.use(createCsrfMiddleware())
    app.get('/login', (c) => {
      getSessionFromContext(c)?.set('userId', 1)
      return c.text('ok')
    })
    app.post('/submit', (c) => c.text('ok'))
    return app
  }

  it('skips verification for a Bearer request carrying no cookies', async () => {
    const app = createBearerApp()

    const post = await app.request('/submit', {
      method: 'POST',
      headers: { Authorization: 'Bearer 1|sometoken' },
    })

    expect(post.status).toBe(200)
  })

  it('still issues the XSRF cookie on the skipped request', async () => {
    const app = createBearerApp()

    const post = await app.request('/submit', {
      method: 'POST',
      headers: { Authorization: 'Bearer 1|sometoken' },
    })

    expect(pickCookie(post, 'XSRF-TOKEN')).not.toBe('')
  })

  it('verifies as usual when the Bearer request carries the session cookie', async () => {
    const app = createBearerApp()
    const session = extractCookie(await app.request('/login'))

    // A forged Authorization header on a victim-browser request: the cookies
    // are what CSRF defends, so the bearer skip must not apply.
    const post = await app.request('/submit', {
      method: 'POST',
      headers: { Cookie: session, Authorization: 'Bearer forged' },
    })

    expect(post.status).toBe(403)
  })

  it('verifies as usual when the Bearer request carries any cookie at all', async () => {
    const app = createBearerApp()

    // Even a cookie this app never reads keeps verification on: the
    // predicate is the Cookie header, not what loaded from it.
    const post = await app.request('/submit', {
      method: 'POST',
      headers: { Cookie: 'unrelated=1', Authorization: 'Bearer 1|sometoken' },
    })

    expect(post.status).toBe(403)
  })

  it('does not fail open when CSRF is mounted before the session middleware', async () => {
    // A hand-composed chain in the wrong order: the skip decision must not
    // depend on whether the session has loaded yet.
    const store = new MemorySessionStore()
    const setup = new Hono()
    setup.use(createSessionMiddleware({ store }))
    setup.use(createCsrfMiddleware())
    setup.get('/login', (c) => {
      getSessionFromContext(c)?.set('userId', 1)
      return c.text('ok')
    })
    const session = extractCookie(await setup.request('/login'))

    const app = new Hono()
    app.use(createCsrfMiddleware())
    app.use(createSessionMiddleware({ store }))
    app.post('/submit', (c) => c.text('ok'))

    const post = await app.request('/submit', {
      method: 'POST',
      headers: { Cookie: session, Authorization: 'Bearer forged' },
    })

    expect(post.status).toBe(403)
  })

  it('skips even when an intermediate middleware writes to the fresh session', async () => {
    // A locale write between session and CSRF makes the new session persist,
    // but a client that sent no cookies still holds no ambient authority.
    const app = new Hono()
    app.use(createSessionMiddleware({ store: new MemorySessionStore() }))
    app.use(async (c, next) => {
      getSessionFromContext(c)?.set('locale', 'en')
      await next()
    })
    app.use(createCsrfMiddleware())
    app.post('/submit', (c) => c.text('ok'))

    const post = await app.request('/submit', {
      method: 'POST',
      headers: { Authorization: 'Bearer 1|sometoken' },
    })

    expect(post.status).toBe(200)
  })

  it('does not skip for non-Bearer Authorization schemes', async () => {
    const app = createBearerApp()

    const post = await app.request('/submit', {
      method: 'POST',
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    })

    expect(post.status).toBe(403)
  })

  it('does not skip for an empty Bearer credential', async () => {
    const app = createBearerApp()

    const post = await app.request('/submit', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' },
    })

    expect(post.status).toBe(403)
  })
})

/**
 * Requests the agent invocation pipeline installed a principal on (RFC 0017
 * §2). Driven through `app.fetch` with a `Request` built here, never through
 * `app.request(...)`: the seam is keyed on object identity, and Hono builds
 * its own `Request` for the latter, keying the map on something the middleware
 * never sees — every case below would then pass for the wrong reason.
 */
describe('seam-marked requests (RFC 0017)', () => {
  function createSeamApp() {
    const app = new Hono()
    app.use(createSessionMiddleware({ store: new MemorySessionStore() }))
    app.use(createCsrfMiddleware())
    app.get('/read', (c) => c.text('ok'))
    app.post('/submit', (c) => c.text('ok'))
    return app
  }

  function seamRequest(path: string, init: RequestInit = {}): Request {
    return installAgentPrincipal(new Request(`http://localhost${path}`, init), {
      principal: { kind: 'service', id: 'agent:triager:1' },
      abilities: ['tools:*'],
    })
  }

  it('skips verification for a seam-marked mutating request', async () => {
    const response = await createSeamApp().fetch(seamRequest('/submit', { method: 'POST' }))
    expect(response.status).toBe(200)
  })

  /**
   * The invariant, asserted rather than assumed. The pipeline builds these
   * requests from scratch and never puts a `Cookie` on one; if a seam-marked
   * request nevertheless carries the header, the premise the exemption rests
   * on has been shown false, and the safe answer is to refuse rather than to
   * widen a CSRF skip.
   */
  it('refuses a seam-marked request that carries any cookie', async () => {
    const response = await createSeamApp().fetch(
      seamRequest('/submit', { method: 'POST', headers: { Cookie: 'unrelated=1' } }),
    )
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('must not carry cookies')
  })

  /**
   * An invariant that only held for POST would not be an invariant. A GET
   * takes the safe-method branch, which skips verification anyway — so nothing
   * but a check placed above every branch can catch this.
   */
  it('refuses a cookie-carrying seam-marked request on a safe method too', async () => {
    const response = await createSeamApp().fetch(
      seamRequest('/read', { headers: { Cookie: 'unrelated=1' } }),
    )
    expect(response.status).toBe(403)
  })

  it('leaves an ordinary cookie-carrying browser request alone', async () => {
    const app = createSeamApp()
    // No seam mark: a plain cookie-bearing POST with no token is still a 403
    // for the ordinary reason, and a safe request still gets its token cookie.
    const read = await app.request('/read')
    expect(read.status).toBe(200)
    expect(read.headers.get('Set-Cookie')).toContain('XSRF-TOKEN=')

    const post = await app.request('/submit', {
      method: 'POST',
      headers: { Cookie: 'unrelated=1' },
    })
    expect(post.status).toBe(403)
    expect(await post.text()).toContain('CSRF token mismatch')
  })

  it('still issues the XSRF cookie on a seam-marked request', async () => {
    // The exemption is verification-only: issuance is untouched.
    const response = await createSeamApp().fetch(seamRequest('/read'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Set-Cookie')).toContain('XSRF-TOKEN=')
  })

  it('does not carry the mark onto a request rebuilt from a marked one', async () => {
    const marked = seamRequest('/submit', { method: 'POST' })
    const response = await createSeamApp().fetch(new Request(marked))
    // A copy is exactly what a caller who has the bytes can construct, so it
    // gets the ordinary answer: no token, no cookie, no exemption.
    expect(response.status).toBe(403)
  })
})
