import { afterEach, describe, expect, it, spyOn, type Mock } from 'bun:test'
import { Hono } from 'hono'
import {
  createSessionMiddleware,
  getSessionFromContext,
  MemorySessionStore,
  type Session,
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

  it('refreshes the TTL of a live entry via touch', async () => {
    let currentTime = 1000
    const store = new MemorySessionStore(() => currentTime)

    await store.write('session-1', { user: 'Alice' }, 60)
    currentTime = 1000 + 50 * 1000
    await store.touch('session-1', 60)

    // Past the original expiry, still alive thanks to the refresh.
    currentTime = 1000 + 90 * 1000
    expect(await store.read('session-1')).toEqual({ user: 'Alice' })
  })

  it('never revives an expired entry via touch', async () => {
    let currentTime = 1000
    const store = new MemorySessionStore(() => currentTime)

    await store.write('session-1', { user: 'Alice' }, 60)
    currentTime = 1000 + 61 * 1000
    await store.touch('session-1', 3600)

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
  function createSpiedStore() {
    const store = new MemorySessionStore()
    return {
      store,
      writes: spyOn(store, 'write'),
      touches: spyOn(store, 'touch'),
      destroys: spyOn(store, 'destroy'),
    }
  }

  // A store without touch support exercises the full-write fallback.
  function createNoTouchStore() {
    const inner = new MemorySessionStore()
    const store: SessionStore = {
      read: (id) => inner.read(id),
      write: (id, data, ttlSeconds) => inner.write(id, data, ttlSeconds),
      destroy: (id) => inner.destroy(id),
    }
    return { store, writes: spyOn(store, 'write') }
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

  async function establishSession(app: Hono, writes: Mock<SessionStore['write']>): Promise<string> {
    const res = await app.request('/login')
    const cookie = res.headers.get('set-cookie')?.split(';')[0]
    if (!cookie) throw new Error('expected session cookie')
    writes.mockClear()
    return cookie
  }

  it('performs zero store operations for an anonymous GET that never touches the session', async () => {
    const { store, writes, touches, destroys } = createSpiedStore()
    const app = createCountingApp(store)

    await app.request('/page')
    await app.request('/page')

    expect(writes).toHaveBeenCalledTimes(0)
    expect(touches).toHaveBeenCalledTimes(0)
    expect(destroys).toHaveBeenCalledTimes(0)
  })

  it('refreshes an unchanged session with touch instead of a full write', async () => {
    const { store, writes, touches } = createSpiedStore()
    const app = createCountingApp(store)
    const cookie = await establishSession(app, writes)

    const res = await app.request('/page', { headers: { Cookie: cookie } })

    expect(writes).toHaveBeenCalledTimes(0)
    expect(touches).toHaveBeenCalledTimes(1)
    // The rolling cookie is still refreshed.
    expect(res.headers.get('set-cookie')).toContain('guren.session=')
  })

  it('falls back to a full write for stores without touch support', async () => {
    const { store, writes } = createNoTouchStore()
    const app = createCountingApp(store)
    const cookie = await establishSession(app, writes)

    await app.request('/page', { headers: { Cookie: cookie } })

    expect(writes).toHaveBeenCalledTimes(1)
  })

  it('writes once when session data changes', async () => {
    const { store, writes, touches } = createSpiedStore()
    const app = createCountingApp(store)
    const cookie = await establishSession(app, writes)

    await app.request('/update', { headers: { Cookie: cookie } })

    expect(writes).toHaveBeenCalledTimes(1)
    expect(touches).toHaveBeenCalledTimes(0)
  })

  it('writes while flash data ages out, then returns to touch-only', async () => {
    const { store, writes, touches } = createSpiedStore()
    const app = createCountingApp(store)
    const cookie = await establishSession(app, writes)

    await app.request('/flash', { headers: { Cookie: cookie } })
    expect(writes).toHaveBeenCalledTimes(1)

    // Aging moves new -> old: write.
    await app.request('/page', { headers: { Cookie: cookie } })
    expect(writes).toHaveBeenCalledTimes(2)

    // Aging clears the consumed old bag: final write.
    await app.request('/page', { headers: { Cookie: cookie } })
    expect(writes).toHaveBeenCalledTimes(3)

    // Flash fully drained: back to touch-only.
    await app.request('/page', { headers: { Cookie: cookie } })
    expect(writes).toHaveBeenCalledTimes(3)
    expect(touches).toHaveBeenCalledTimes(1)
  })

  it('writes the new id and destroys the old one on regeneration', async () => {
    const { store, writes, destroys } = createSpiedStore()
    const app = createCountingApp(store)
    const cookie = await establishSession(app, writes)

    await app.request('/rotate', { headers: { Cookie: cookie } })

    expect(writes).toHaveBeenCalledTimes(1)
    expect(destroys).toHaveBeenCalledTimes(1)
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

  it('persists a new session hydrated with testing data', async () => {
    process.env.GUREN_TESTING = '1'
    const store = new MemorySessionStore()
    const app = createTestApp({ store })
    const writes = spyOn(store, 'write')

    const res = await app.request('/session', {
      headers: { 'X-Testing-Session': JSON.stringify({ userId: 7 }) },
    })

    // Hydrated content counts as content: the empty-new-session rule must
    // not drop testing sessions.
    expect(await res.json()).toEqual({ userId: 7 })
    expect(writes).toHaveBeenCalledTimes(1)
    expect(res.headers.get('set-cookie')).toContain('guren.session=')
  })

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

describe('willPersist agrees with what the next request finds', () => {
  // willPersist() restates the finalizer's survival decision so that callers
  // anchoring a value to the session id (CSRF token binding) can ask for it
  // up front. Nothing in the type system keeps the two in step, so pin every
  // lifecycle branch here: if the finalizer's write-reduction rules change
  // and willPersist() is not updated with them, a token gets bound to an id
  // no later request can match, and the symptom surfaces as a CSRF 403 far
  // from the edit.
  const paths: Array<{ name: string; act: (session: Session) => void }> = [
    { name: 'untouched brand-new session', act: () => {} },
    { name: 'new session that stores data', act: (s) => s.set('userId', 1) },
    { name: 'new session with only flash', act: (s) => s.flash('notice', 'hi') },
    { name: 'new session regenerated then written', act: (s) => { s.regenerate(); s.set('userId', 1) } },
    { name: 'invalidated session', act: (s) => { s.set('userId', 1); s.invalidate() } },
  ]

  for (const { name, act } of paths) {
    it(name, async () => {
      const store = new MemorySessionStore()
      const app = new Hono()
      app.use(createSessionMiddleware({ store }))

      let claimed: boolean | undefined
      let claimedId: string | undefined
      app.get('/act', (c) => {
        const session = getSessionFromContext(c)!
        act(session)
        claimed = session.willPersist!()
        claimedId = session.id
        return c.text('ok')
      })

      await app.request('/act')

      // The claim made mid-request must match what the store actually holds
      // once the response is finalized.
      const stored = await store.read(claimedId!)
      expect(claimed).toBe(stored !== undefined)
    })
  }

  it('an established session survives an untouched request (rolling expiry)', async () => {
    const store = new MemorySessionStore()
    const app = new Hono()
    app.use(createSessionMiddleware({ store }))

    let claimed: boolean | undefined
    let claimedId: string | undefined
    app.get('/login', (c) => {
      getSessionFromContext(c)!.set('userId', 1)
      return c.text('ok')
    })
    app.get('/idle', (c) => {
      const session = getSessionFromContext(c)!
      claimed = session.willPersist!()
      claimedId = session.id
      return c.text('ok')
    })

    const login = await app.request('/login')
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    await app.request('/idle', { headers: { Cookie: cookie } })

    expect(claimed).toBe(true)
    expect(await store.read(claimedId!)).toBeDefined()
  })
})
