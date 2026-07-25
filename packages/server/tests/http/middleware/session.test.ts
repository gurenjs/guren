import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import {
  createSessionMiddleware,
  getSessionFromContext,
  MemorySessionStore,
  type SessionStore,
} from '../../../src/http/middleware/session'

const APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

process.env.APP_KEY = APP_KEY
delete process.env.APP_PREVIOUS_KEYS

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

    // An untouched new session is not persisted and issues no cookie.
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('issues a cookie once a new session stores data', async () => {
    const app = createTestApp()

    app.get('/test', (c) => {
      getSessionFromContext(c)?.set('visited', true)
      return c.text('ok')
    })

    const res = await app.request('/test')

    expect(res.headers.get('set-cookie')).toContain('guren.session=')
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

  it('creates a new session when cookie signature is tampered', async () => {
    const store = new MemorySessionStore()
    const app = createTestApp({ store })

    app.get('/set', (c) => {
      const session = getSessionFromContext(c)
      session?.set('visited', true)
      return c.text('ok')
    })

    app.get('/check', (c) => c.json(getSessionFromContext(c)?.all() ?? {}))

    const res1 = await app.request('/set')
    const cookie = res1.headers.get('set-cookie')?.split(';')[0] ?? ''
    const tampered = `${cookie}x`

    const res2 = await app.request('/check', {
      headers: { Cookie: tampered },
    })

    expect(await res2.json()).toEqual({})
  })

  it('creates a new session when receiving an unsigned legacy cookie', async () => {
    const store = new MemorySessionStore()
    const app = createTestApp({ store })

    app.get('/check', (c) => c.json({ isNew: getSessionFromContext(c)?.isNew }))

    const res = await app.request('/check', {
      headers: { Cookie: 'guren.session=legacy-session-id' },
    })

    expect(await res.json()).toEqual({ isNew: true })
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

    app.get('/test', (c) => {
      getSessionFromContext(c)?.set('visited', true)
      return c.text('ok')
    })

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

    app.get('/test', (c) => {
      getSessionFromContext(c)?.set('visited', true)
      return c.text('ok')
    })

    const res = await app.request('/test')
    const setCookie = res.headers.get('set-cookie')

    expect(setCookie).toContain('Path=/api')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('HttpOnly')
  })
})

describe('session write volume', () => {
  class CountingStore extends MemorySessionStore {
    writes = 0
    touches = 0
    destroys = 0

    override async write(id: string, data: Record<string, unknown>, ttlSeconds: number): Promise<void> {
      this.writes += 1
      await super.write(id, data, ttlSeconds)
    }

    override async touch(id: string, ttlSeconds: number): Promise<void> {
      this.touches += 1
      await super.touch(id, ttlSeconds)
    }

    override async destroy(id: string): Promise<void> {
      this.destroys += 1
      await super.destroy(id)
    }
  }

  // A store without touch support exercises the full-write fallback.
  class NoTouchStore implements SessionStore {
    writes = 0
    private readonly inner = new MemorySessionStore()

    async read(id: string) {
      return this.inner.read(id)
    }

    async write(id: string, data: Record<string, unknown>, ttlSeconds: number): Promise<void> {
      this.writes += 1
      await this.inner.write(id, data, ttlSeconds)
    }

    async destroy(id: string): Promise<void> {
      await this.inner.destroy(id)
    }
  }

  // Hono forbids adding routes once a request has been handled, so every
  // route is registered up front and /login establishes the session.
  function createCountingApp(store: SessionStore) {
    const app = new Hono()
    app.use('*', createSessionMiddleware({ store }))
    app.get('/login', (c) => {
      getSessionFromContext(c)?.set('userId', 7)
      return c.text('ok')
    })
    app.get('/page', (c) => c.text('ok'))
    app.get('/update', (c) => {
      getSessionFromContext(c)?.set('theme', 'dark')
      return c.text('ok')
    })
    app.get('/flash', (c) => {
      getSessionFromContext(c)?.flash('status', 'saved')
      return c.text('ok')
    })
    app.get('/rotate', (c) => {
      getSessionFromContext(c)?.regenerate()
      return c.text('ok')
    })
    return app
  }

  async function establishSession(app: Hono, store: CountingStore | NoTouchStore): Promise<string> {
    const res = await app.request('/login')
    const cookie = res.headers.get('set-cookie')?.split(';')[0]
    if (!cookie) throw new Error('expected session cookie')
    store.writes = 0
    return cookie
  }

  it('performs zero store operations for an anonymous GET that never touches the session', async () => {
    const store = new CountingStore()
    const app = createCountingApp(store)

    await app.request('/page')
    await app.request('/page')

    expect(store.writes).toBe(0)
    expect(store.touches).toBe(0)
    expect(store.destroys).toBe(0)
  })

  it('refreshes an unchanged session with touch instead of a full write', async () => {
    const store = new CountingStore()
    const app = createCountingApp(store)
    const cookie = await establishSession(app, store)

    const res = await app.request('/page', { headers: { Cookie: cookie } })

    expect(store.writes).toBe(0)
    expect(store.touches).toBe(1)
    // The rolling cookie is still refreshed.
    expect(res.headers.get('set-cookie')).toContain('guren.session=')
  })

  it('falls back to a full write for stores without touch support', async () => {
    const store = new NoTouchStore()
    const app = createCountingApp(store)
    const cookie = await establishSession(app, store)

    await app.request('/page', { headers: { Cookie: cookie } })

    expect(store.writes).toBe(1)
  })

  it('writes once when session data changes', async () => {
    const store = new CountingStore()
    const app = createCountingApp(store)
    const cookie = await establishSession(app, store)

    await app.request('/update', { headers: { Cookie: cookie } })

    expect(store.writes).toBe(1)
    expect(store.touches).toBe(0)
  })

  it('writes while flash data ages out, then returns to touch-only', async () => {
    const store = new CountingStore()
    const app = createCountingApp(store)
    const cookie = await establishSession(app, store)

    await app.request('/flash', { headers: { Cookie: cookie } })
    expect(store.writes).toBe(1)

    // Aging moves new → old: write.
    await app.request('/page', { headers: { Cookie: cookie } })
    expect(store.writes).toBe(2)

    // Aging clears the consumed old bag: final write.
    await app.request('/page', { headers: { Cookie: cookie } })
    expect(store.writes).toBe(3)

    // Flash fully drained: back to touch-only.
    await app.request('/page', { headers: { Cookie: cookie } })
    expect(store.writes).toBe(3)
    expect(store.touches).toBe(1)
  })

  it('writes the new id and destroys the old one on regeneration', async () => {
    const store = new CountingStore()
    const app = createCountingApp(store)
    const cookie = await establishSession(app, store)

    await app.request('/rotate', { headers: { Cookie: cookie } })

    expect(store.writes).toBe(1)
    expect(store.destroys).toBe(1)
  })
})

describe('X-Testing-Session hydration', () => {
  const originalTesting = process.env.GUREN_TESTING

  afterEach(() => {
    if (originalTesting === undefined) {
      delete process.env.GUREN_TESTING
    } else {
      process.env.GUREN_TESTING = originalTesting
    }
  })

  function createTestApp(options?: Parameters<typeof createSessionMiddleware>[0]) {
    const app = new Hono()
    app.use(createSessionMiddleware(options))
    app.get('/session', (c) => c.json(getSessionFromContext(c)?.all() ?? {}))
    return app
  }

  it('hydrates session from header when GUREN_TESTING is set', async () => {
    process.env.GUREN_TESTING = '1'
    const app = createTestApp()

    const res = await app.request('/session', {
      headers: { 'X-Testing-Session': JSON.stringify({ step: 2, cart: ['a'] }) },
    })

    expect(await res.json()).toEqual({ step: 2, cart: ['a'] })
  })

  it('ignores header when GUREN_TESTING is not set', async () => {
    delete process.env.GUREN_TESTING
    const app = createTestApp()

    const res = await app.request('/session', {
      headers: { 'X-Testing-Session': JSON.stringify({ forged: true }) },
    })

    expect(await res.json()).toEqual({})
  })

  it('ignores malformed or non-object header payloads', async () => {
    process.env.GUREN_TESTING = '1'
    const app = createTestApp()

    for (const payload of ['not-json', '"string"', '[1,2]', 'null']) {
      const res = await app.request('/session', {
        headers: { 'X-Testing-Session': payload },
      })
      expect(await res.json()).toEqual({})
    }
  })

  it('merges testing data over stored session data', async () => {
    process.env.GUREN_TESTING = '1'
    const store = new MemorySessionStore()
    const app = createTestApp({ store })

    app.get('/set', (c) => {
      const session = getSessionFromContext(c)
      session?.set('kept', 'stored')
      session?.set('overridden', 'stored')
      return c.text('ok')
    })

    const res1 = await app.request('/set')
    const cookie = res1.headers.get('set-cookie')?.split(';')[0] ?? ''

    const res2 = await app.request('/session', {
      headers: {
        Cookie: cookie,
        'X-Testing-Session': JSON.stringify({ overridden: 'testing', added: true }),
      },
    })

    expect(await res2.json()).toEqual({ kept: 'stored', overridden: 'testing', added: true })
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
