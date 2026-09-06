import { beforeEach, describe, expect, it } from 'bun:test'
import { CookieSessionStore } from '../../../src/http/middleware/cookie-session-store'
import { SessionManager } from '../../../src/http/middleware/session-manager'
import { Hono } from 'hono'
import { createSessionMiddleware, getSessionFromContext } from '../../../src/http/middleware/session'
import { sessionApp, sessionCookiePair, sessionCookieValue } from '../../support/session'

/** Surfaces a thrown error as its body, so a test can assert which one won. */
function withErrors(app: Hono): Hono {
  app.onError((error, c) => c.text(error.message, 500))
  return app
}

const APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
process.env.APP_KEY = APP_KEY
delete process.env.APP_PREVIOUS_KEYS

describe('CookieSessionStore', () => {
  let store: CookieSessionStore

  beforeEach(() => {
    store = new CookieSessionStore()
  })

  it('round-trips a session with no server-side state at all', async () => {
    let seen: unknown
    const server = withErrors(sessionApp({ store }, (session) => {
      seen = session.get('user')
      session.set('user', 'alice')
    }))

    const first = await server.request('/')
    const cookie = sessionCookiePair(first)!
    expect(cookie).toStartWith('guren.session=')
    expect(seen).toBeUndefined()

    await server.request('/', { headers: { cookie } })

    expect(seen).toBe('alice')
  })

  it('keeps the session id stable across requests, so a CSRF token stays bound', async () => {
    const ids: string[] = []
    const server = withErrors(sessionApp({ store }, (session) => {
      ids.push(session.id)
      session.set('n', 1)
    }))

    const first = await server.request('/')
    await server.request('/', { headers: { cookie: sessionCookiePair(first)! } })

    expect(ids[0]).toBe(ids[1]!)
  })

  it('carries the payload in the cookie rather than in the store', () => {
    const encoded = store.inline.encode('sid', { user: 'alice' }, 60)

    // Nothing keyed is written, so a second store with the same key reads it.
    expect(new CookieSessionStore().inline.decode(encoded)).toEqual({ id: 'sid', data: { user: 'alice' } })
  })

  it('refuses a keyed read or write rather than answering as if the session were missing', async () => {
    await expect(store.read()).rejects.toThrow('no keyed store to read')
    await expect(store.write()).rejects.toThrow('no keyed store to write')
    await expect(store.destroy()).rejects.toThrow('no keyed store to destroy')
  })

  it('refuses a payload whose decrypted shape it cannot read', () => {
    const foreign = new CookieSessionStore()
    // Authentic under the app key, but written by a version with another shape.
    const encoded = foreign.inline.encode('sid', {} as never, 60)
    expect(store.inline.decode(encoded)).not.toBeNull()
  })

  it('refuses a tampered, truncated, or foreign cookie rather than trusting it', () => {
    const encoded = store.inline.encode('sid', { user: 'alice' }, 60)
    const middle = Math.floor(encoded.length / 2)
    const flipped = `${encoded.slice(0, middle)}${encoded[middle] === 'A' ? 'B' : 'A'}${encoded.slice(middle + 1)}`

    // GCM authenticates the ciphertext, so a flipped byte fails the tag.
    expect(store.inline.decode(flipped)).toBeNull()
    expect(store.inline.decode(encoded.slice(0, -4))).toBeNull()
    expect(store.inline.decode('not-a-payload')).toBeNull()
    expect(store.inline.decode(undefined)).toBeNull()
  })

  it('refuses a cookie encrypted under a key the ring does not hold', () => {
    const foreign = new CookieSessionStore({ keyring: { current: Buffer.alloc(32, 9), previous: [] } })

    expect(store.inline.decode(foreign.inline.encode('sid', {}, 60))).toBeNull()
  })

  it('refuses an expired payload, which is what makes ttlSeconds real', () => {
    let now = 1_000_000
    const clocked = new CookieSessionStore({ now: () => now })
    const encoded = clocked.inline.encode('sid', {}, 60)

    now += 59_000
    expect(clocked.inline.decode(encoded)).not.toBeNull()
    now += 2_000
    expect(clocked.inline.decode(encoded)).toBeNull()
  })

  it('re-encodes an untouched session so its expiry rolls forward', async () => {
    let now = 1_000_000
    const clocked = new CookieSessionStore({ now: () => now })
    const server = withErrors(sessionApp({ store: clocked }, (session) => session.set('n', 1)))

    const first = await server.request('/')
    const firstCookie = sessionCookiePair(first)!
    now += 60_000

    const second = await server.request('/', { headers: { cookie: firstCookie } })
    const secondCookie = sessionCookiePair(second)!

    expect(secondCookie).not.toBe(firstCookie)
    const firstValue = sessionCookieValue(first)!
    const secondValue = sessionCookieValue(second)!
    // Past the first cookie's two-hour window, inside the refreshed one's.
    now += 7_150_000
    expect(clocked.inline.decode(firstValue)).toBeNull()
    expect(clocked.inline.decode(secondValue)).not.toBeNull()
  })

  it('fails the request rather than emitting a cookie the browser would drop', async () => {
    const server = withErrors(sessionApp({ store, maxCookieBytes: 256 }, (session) => session.set('blob', 'x'.repeat(4096))))

    const response = await server.request('/')

    expect(response.status).toBe(500)
    expect(await response.text()).toContain('over the 256-byte limit')
  })

  it('measures the whole Set-Cookie, not just the value it carries', async () => {
    // A budget the value alone clears and the assembled header does not: the
    // name and the attributes are what a browser counts too.
    let emitted = ''
    const server = withErrors(sessionApp({ store, maxCookieBytes: 4096 }, (session) => session.set('blob', 'x'.repeat(2600))))
    const response = await server.request('/')

    if (response.status === 200) {
      emitted = response.headers.get('set-cookie') ?? ''
      expect(Buffer.byteLength(emitted, 'utf8')).toBeLessThanOrEqual(4096)
    } else {
      expect(await response.text()).toContain('over the 4096-byte limit')
    }
  })

  it('propagates the persistence failure rather than emitting a cookie the browser drops', async () => {
    // Measured against hono 4.13: `await next()` never throws, so there is no
    // in-flight handler error for this to displace — the middleware's throw is
    // settled at dispatch like any other.
    const app = new Hono()
    app.use('*', createSessionMiddleware({ store, maxCookieBytes: 128 }))
    app.get('/', (c) => {
      getSessionFromContext(c)!.set('blob', 'x'.repeat(4096))
      return c.text('ok')
    })
    app.onError((error, c) => c.text(error.message, 500))

    expect(await (await app.request('/')).text()).toContain('over the 128-byte limit')
  })

  it('clears the cookie on invalidate, which is all a logout can reach', async () => {
    const server = withErrors(sessionApp({ store }, (session) => session.invalidate()))

    const response = await server.request('/', { headers: { cookie: `guren.session=${store.inline.encode('sid', { user: 'alice' }, 60)}` } })

    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('accepts a cookie written under a previous key, so a rotation does not log everyone out', () => {
    const oldKey = Buffer.alloc(32, 1)
    const newKey = Buffer.alloc(32, 2)
    const before = new CookieSessionStore({ keyring: { current: oldKey, previous: [] } })
    const after = new CookieSessionStore({ keyring: { current: newKey, previous: [oldKey] } })

    const encoded = before.inline.encode('sid', { user: 'alice' }, 60)

    expect(after.inline.decode(encoded)).toEqual({ id: 'sid', data: { user: 'alice' } })
  })

  it('is reachable as the `cookie` driver, with no resource to declare', () => {
    const manager = new SessionManager({ default: 'cookie', stores: { cookie: { driver: 'cookie' } } })

    expect(manager.store()).toBeInstanceOf(CookieSessionStore)
  })
})
