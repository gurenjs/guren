import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import {
  createCsrfMiddleware,
  CSRF_FORM_FIELD,
  CSRF_HEADER_NAME,
  csrfField,
  getCsrfToken,
  verifyCsrfToken,
} from '../../../src/http/middleware/csrf'
import { createSessionMiddleware, getSessionFromContext } from '../../../src/http/middleware/session'

function createTestApp(csrfOptions?: Parameters<typeof createCsrfMiddleware>[0]) {
  const app = new Hono()
  app.use(createSessionMiddleware())
  app.use(createCsrfMiddleware(csrfOptions))
  return app
}

function extractCookie(res: Response): string {
  // When multiple Set-Cookie headers exist (session + XSRF-TOKEN),
  // collect all cookies and join them so the session is preserved.
  const cookies = res.headers.getSetCookie?.() ?? []
  if (cookies.length > 0) {
    return cookies.map((c) => c.split(';')[0]).join('; ')
  }
  return res.headers.get('set-cookie')?.split(';')[0] ?? ''
}

describe('getCsrfToken', () => {
  it('generates and stores token in session', async () => {
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
    expect(token1).toBe(token2) // Same token on repeated calls
  })

  it('throws error when session middleware is not registered', async () => {
    const app = new Hono()
    app.use(createCsrfMiddleware())

    app.get('/token', (c) => {
      return c.json({ token: getCsrfToken(c) })
    })

    app.onError((err, c) => {
      return c.json({ error: err.message }, 500)
    })

    const res = await app.request('/token')
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toContain('session middleware')
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
    expect(html).toMatch(/value="[a-f0-9-]+"/)
  })
})

describe('verifyCsrfToken', () => {
  it('returns true for matching token', async () => {
    const app = createTestApp()
    let result: boolean | undefined

    app.get('/test', (c) => {
      const token = getCsrfToken(c)
      result = verifyCsrfToken(c, token)
      return c.text('ok')
    })

    await app.request('/test')

    expect(result).toBe(true)
  })

  it('returns false for mismatched token', async () => {
    const app = createTestApp()
    let result: boolean | undefined

    app.get('/test', (c) => {
      getCsrfToken(c) // Generate token
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

    // Get token and cookie
    const getRes = await app.request('/form')
    const cookie = extractCookie(getRes)

    // Submit with token
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

    // Get token and cookie
    const getRes = await app.request('/api/token')
    const cookie = extractCookie(getRes)

    // Submit with header
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

    // Get token and cookie
    const getRes = await app.request('/api/token')
    const cookie = extractCookie(getRes)

    // Submit with token in JSON body
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

  it('excludes specified paths from protection', async () => {
    const app = createTestApp({
      exclude: ['/api/webhooks/*', '/health'],
    })

    app.post('/api/webhooks/stripe', (c) => c.text('webhook received'))
    app.post('/api/webhooks/github', (c) => c.text('webhook received'))
    app.post('/health', (c) => c.text('healthy'))
    app.post('/api/data', (c) => c.text('data'))

    // Excluded paths should work without token
    const webhookRes = await app.request('/api/webhooks/stripe', { method: 'POST' })
    expect(webhookRes.status).toBe(200)

    const githubRes = await app.request('/api/webhooks/github', { method: 'POST' })
    expect(githubRes.status).toBe(200)

    const healthRes = await app.request('/health', { method: 'POST' })
    expect(healthRes.status).toBe(200)

    // Non-excluded path should still require token
    const dataRes = await app.request('/api/data', { method: 'POST' })
    expect(dataRes.status).toBe(403)
  })

  it('uses custom error handler when provided', async () => {
    const app = createTestApp({
      onError: (ctx) =>
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
      methods: ['POST'], // Only protect POST, not PUT/PATCH/DELETE
    })

    app.post('/data', (c) => c.text('post'))
    app.put('/data', (c) => c.text('put'))
    app.delete('/data', (c) => c.text('delete'))

    const postRes = await app.request('/data', { method: 'POST' })
    expect(postRes.status).toBe(403) // Protected

    const putRes = await app.request('/data', { method: 'PUT' })
    expect(putRes.status).toBe(200) // Not protected

    const deleteRes = await app.request('/data', { method: 'DELETE' })
    expect(deleteRes.status).toBe(200) // Not protected
  })

  it('rejects requests with wrong token', async () => {
    const app = createTestApp()

    app.get('/form', (c) => {
      getCsrfToken(c)
      return c.text('form')
    })

    app.post('/submit', (c) => c.text('submitted'))

    // Get cookie (which has the real token)
    const getRes = await app.request('/form')
    const cookie = extractCookie(getRes)

    // Submit with wrong token
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
    expect(token1).toBe(token2) // Same token across session
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
