import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import {
  createSessionMiddleware,
  getSessionFromContext,
  MemorySessionStore,
} from '../../../src/http/middleware/session'

describe('MemorySessionStore', () => {
  it('reads and writes session data', async () => {
    const store = new MemorySessionStore()

    await store.write('session-1', { user: 'Alice' }, 3600)
    const data = await store.read('session-1')

    expect(data).toEqual({ user: 'Alice' })
  })

  it('returns undefined for non-existent sessions', async () => {
    const store = new MemorySessionStore()

    const data = await store.read('non-existent')

    expect(data).toBeUndefined()
  })

  it('destroys session data', async () => {
    const store = new MemorySessionStore()

    await store.write('session-1', { user: 'Alice' }, 3600)
    await store.destroy('session-1')
    const data = await store.read('session-1')

    expect(data).toBeUndefined()
  })

  it('expires sessions after TTL', async () => {
    let currentTime = 1000
    const store = new MemorySessionStore(() => currentTime)

    await store.write('session-1', { user: 'Alice' }, 60) // 60 seconds TTL

    // Before expiry
    currentTime = 1000 + 59 * 1000
    expect(await store.read('session-1')).toEqual({ user: 'Alice' })

    // After expiry
    currentTime = 1000 + 61 * 1000
    expect(await store.read('session-1')).toBeUndefined()
  })

  it('returns a copy of session data to prevent mutation', async () => {
    const store = new MemorySessionStore()

    await store.write('session-1', { count: 1 }, 3600)
    const data1 = await store.read('session-1')
    if (data1) {
      data1.count = 999
    }

    const data2 = await store.read('session-1')
    expect(data2).toEqual({ count: 1 })
  })
})

describe('createSessionMiddleware', () => {
  function createTestApp(options?: Parameters<typeof createSessionMiddleware>[0]) {
    const app = new Hono()
    app.use(createSessionMiddleware(options))
    return app
  }

  it('creates a new session when no cookie is present', async () => {
    const app = createTestApp()
    let sessionId: string | undefined
    let isNew: boolean | undefined

    app.get('/test', (c) => {
      const session = getSessionFromContext(c)
      sessionId = session?.id
      isNew = session?.isNew
      return c.text('ok')
    })

    const res = await app.request('/test')

    expect(res.status).toBe(200)
    expect(sessionId).toBeDefined()
    expect(isNew).toBe(true)

    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('guren.session=')
  })

  it('reuses existing session when cookie is present', async () => {
    const store = new MemorySessionStore()
    const app = createTestApp({ store })
    let isNew: boolean | undefined

    // First request to create session
    app.get('/create', (c) => {
      const session = getSessionFromContext(c)
      session?.set('visited', true)
      return c.text('ok')
    })

    app.get('/check', (c) => {
      const session = getSessionFromContext(c)
      isNew = session?.isNew
      return c.json({ visited: session?.get('visited') })
    })

    const res1 = await app.request('/create')
    const cookie = res1.headers.get('set-cookie')
    const sessionCookie = cookie?.split(';')[0]

    const res2 = await app.request('/check', {
      headers: { Cookie: sessionCookie ?? '' },
    })

    expect(res2.status).toBe(200)
    const body = await res2.json()
    expect(body).toEqual({ visited: true })
    expect(isNew).toBe(false)
  })

  it('allows session.get and session.set', async () => {
    const app = createTestApp()

    app.get('/set', (c) => {
      const session = getSessionFromContext(c)
      session?.set('name', 'Alice')
      session?.set('count', 42)
      return c.text('set')
    })

    app.get('/get', (c) => {
      const session = getSessionFromContext(c)
      return c.json({
        name: session?.get('name'),
        count: session?.get('count'),
        missing: session?.get('missing'),
      })
    })

    const res1 = await app.request('/set')
    const cookie = res1.headers.get('set-cookie')?.split(';')[0]

    const res2 = await app.request('/get', {
      headers: { Cookie: cookie ?? '' },
    })

    const body = await res2.json()
    // session.get() returns undefined for missing keys, which becomes absent in JSON
    expect(body).toEqual({ name: 'Alice', count: 42 })
  })

  it('supports session.all() to get all data', async () => {
    const app = createTestApp()

    app.get('/test', (c) => {
      const session = getSessionFromContext(c)
      session?.set('a', 1)
      session?.set('b', 2)
      return c.json(session?.all())
    })

    const res = await app.request('/test')
    const body = await res.json()

    expect(body).toEqual({ a: 1, b: 2 })
  })

  it('supports session.has() to check for keys', async () => {
    const app = createTestApp()

    app.get('/test', (c) => {
      const session = getSessionFromContext(c)
      session?.set('exists', 'yes')
      return c.json({
        hasExists: session?.has('exists'),
        hasMissing: session?.has('missing'),
      })
    })

    const res = await app.request('/test')
    const body = await res.json()

    expect(body).toEqual({ hasExists: true, hasMissing: false })
  })

  it('supports session.forget() to remove a key', async () => {
    const store = new MemorySessionStore()
    const app = createTestApp({ store })

    app.get('/set', (c) => {
      const session = getSessionFromContext(c)
      session?.set('keep', 'yes')
      session?.set('remove', 'soon')
      return c.text('set')
    })

    app.get('/forget', (c) => {
      const session = getSessionFromContext(c)
      session?.forget('remove')
      return c.json(session?.all())
    })

    const res1 = await app.request('/set')
    const cookie = res1.headers.get('set-cookie')?.split(';')[0]

    const res2 = await app.request('/forget', {
      headers: { Cookie: cookie ?? '' },
    })

    const body = await res2.json()
    expect(body).toEqual({ keep: 'yes' })
  })

  it('supports session.flush() to clear all data', async () => {
    const store = new MemorySessionStore()
    const app = createTestApp({ store })

    app.get('/set', (c) => {
      const session = getSessionFromContext(c)
      session?.set('a', 1)
      session?.set('b', 2)
      return c.text('set')
    })

    app.get('/flush', (c) => {
      const session = getSessionFromContext(c)
      session?.flush()
      return c.json(session?.all())
    })

    const res1 = await app.request('/set')
    const cookie = res1.headers.get('set-cookie')?.split(';')[0]

    const res2 = await app.request('/flush', {
      headers: { Cookie: cookie ?? '' },
    })

    const body = await res2.json()
    expect(body).toEqual({})
  })

  it('supports session.invalidate() to destroy session', async () => {
    const store = new MemorySessionStore()
    const app = createTestApp({ store })

    app.get('/set', (c) => {
      const session = getSessionFromContext(c)
      session?.set('secret', 'data')
      return c.text('set')
    })

    app.get('/invalidate', (c) => {
      const session = getSessionFromContext(c)
      session?.invalidate()
      return c.text('invalidated')
    })

    const res1 = await app.request('/set')
    const cookie = res1.headers.get('set-cookie')?.split(';')[0]

    const res2 = await app.request('/invalidate', {
      headers: { Cookie: cookie ?? '' },
    })

    // Cookie should be deleted
    const setCookie = res2.headers.get('set-cookie')
    expect(setCookie).toContain('Max-Age=0')
  })

  it('supports session.regenerate() to create new ID', async () => {
    const store = new MemorySessionStore()
    const app = createTestApp({ store })
    let originalId: string | undefined
    let regeneratedId: string | undefined

    app.get('/set', (c) => {
      const session = getSessionFromContext(c)
      originalId = session?.id
      session?.set('user', 'Alice')
      return c.text('set')
    })

    app.get('/regenerate', (c) => {
      const session = getSessionFromContext(c)
      session?.regenerate()
      regeneratedId = session?.id
      return c.json({ user: session?.get('user') })
    })

    const res1 = await app.request('/set')
    const cookie = res1.headers.get('set-cookie')?.split(';')[0]

    const res2 = await app.request('/regenerate', {
      headers: { Cookie: cookie ?? '' },
    })

    const body = await res2.json()
    expect(body).toEqual({ user: 'Alice' })
    expect(regeneratedId).toBeDefined()
    expect(regeneratedId).not.toBe(originalId)
  })

  it('respects custom cookie name', async () => {
    const app = createTestApp({ cookieName: 'my_session' })

    app.get('/test', (c) => c.text('ok'))

    const res = await app.request('/test')
    const setCookie = res.headers.get('set-cookie')

    expect(setCookie).toContain('my_session=')
  })

  it('respects cookie options', async () => {
    const app = createTestApp({
      cookiePath: '/api',
      cookieSecure: false,
      cookieSameSite: 'Strict',
      cookieHttpOnly: true,
    })

    app.get('/test', (c) => c.text('ok'))

    const res = await app.request('/test')
    const setCookie = res.headers.get('set-cookie')

    expect(setCookie).toContain('Path=/api')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('HttpOnly')
  })
})

describe('getSessionFromContext', () => {
  it('returns undefined when no session middleware is used', async () => {
    const app = new Hono()

    app.get('/test', (c) => {
      const session = getSessionFromContext(c)
      return c.json({ hasSession: session !== undefined })
    })

    const res = await app.request('/test')
    const body = await res.json()
    expect(body).toEqual({ hasSession: false })
  })
})
