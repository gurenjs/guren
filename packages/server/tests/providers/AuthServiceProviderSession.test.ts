import { describe, expect, it } from 'bun:test'
import { createApp } from '../../src/http/Application'
import { ServiceProvider } from '../../src/container/ServiceProvider'
import { MemorySessionStore, type SessionStore } from '../../src/http/middleware/session'
import { SessionManager } from '../../src/http/middleware/session-manager'
import { getSessionFromContext } from '../../src/http/middleware/session'
import type { Router } from '../../src/mvc/Router'

process.env.APP_KEY ??= 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

/** A store that records every write, so a test can see which one the app used. */
function recordingStore(): SessionStore & { writes: string[] } {
  const data = new Map<string, Record<string, unknown>>()
  return {
    writes: [],
    async read(id) { return data.get(id) },
    async write(id, value) { this.writes.push(id); data.set(id, value) },
    async destroy(id) { data.delete(id) },
  }
}

function sessionProvider(manager: SessionManager) {
  return class SessionProvider extends ServiceProvider {
    register(): void {
      this.container.instance('session', manager)
    }
  }
}

function routes(router: Router): void {
  router.get('/touch', (c) => {
    getSessionFromContext(c)!.set('seen', true)
    return c.text('ok')
  })
}

describe('AuthServiceProvider session resolution (RFC 0020)', () => {
  it('should write sessions through the store a bound SessionManager selects', async () => {
    const store = recordingStore()
    const manager = new SessionManager({ default: 'custom', stores: { custom: { driver: 'custom' } as never } })
    manager.registerDriver('custom', () => store)
    const app = createApp({ routes, auth: {}, providers: [sessionProvider(manager)] })
    await app.boot()

    const response = await app.fetch(new Request('http://localhost/touch'))

    expect(response.status).toBe(200)
    expect(store.writes).toHaveLength(1)
    expect(response.headers.get('set-cookie')).toContain('guren.session=')
  })

  it('should take cookie settings from the manager, with auth.sessionOptions overriding field by field', async () => {
    const manager = new SessionManager({ cookieName: 'from-manager', ttlSeconds: 10, stores: { memory: { driver: 'memory' } } })
    const app = createApp({
      routes,
      auth: { sessionOptions: { cookieName: 'from-auth' } },
      providers: [sessionProvider(manager)],
    })
    await app.boot()

    const response = await app.fetch(new Request('http://localhost/touch'))

    expect(response.headers.get('set-cookie')).toContain('from-auth=')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=10')
  })

  it('should fail the boot when both a manager and an explicit store are configured', async () => {
    const app = createApp({
      routes,
      auth: { sessionOptions: { store: new MemorySessionStore() } },
      providers: [sessionProvider(new SessionManager())],
    })

    await expect(app.boot()).rejects.toThrow('Sessions are configured twice')
  })

  it('should keep an explicit store working with no manager bound', async () => {
    const store = recordingStore()
    const app = createApp({ routes, auth: { sessionOptions: { store } } })
    await app.boot()

    await app.fetch(new Request('http://localhost/touch'))

    expect(store.writes).toHaveLength(1)
  })

  it('should not build the manager store before the first request', async () => {
    let built = 0
    const manager = new SessionManager({ default: 'lazy', stores: { lazy: { driver: 'lazy' } as never } })
    manager.registerDriver('lazy', () => { built += 1; return new MemorySessionStore() })
    const app = createApp({ routes, auth: {}, providers: [sessionProvider(manager)] })
    await app.boot()

    expect(built).toBe(0)
    await app.fetch(new Request('http://localhost/touch'))
    await app.fetch(new Request('http://localhost/touch'))
    expect(built).toBe(1)
  })
})
