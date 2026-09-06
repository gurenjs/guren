import { describe, expect, it, spyOn } from 'bun:test'
import { createApp, type Application } from '../../src/http/Application'
import { ServiceProvider } from '../../src/container/ServiceProvider'
import { getSessionFromContext, MemorySessionStore } from '../../src/http/middleware/session'
import { SessionManager } from '../../src/http/middleware/session-manager'
import type { Router } from '../../src/mvc/Router'

process.env.APP_KEY ??= 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

/** A manager whose default store is `store`, through a driver registered after construction. */
function managerFor(store: MemorySessionStore, options: { cookieName?: string; ttlSeconds?: number } = {}): SessionManager {
  const manager = new SessionManager({ ...options, default: 'custom', stores: { custom: { driver: 'custom' } as never } })
  manager.registerDriver('custom', () => store)
  return manager
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

/** Boot, then hit the one route that writes to the session. */
async function touch(app: Application): Promise<Response> {
  await app.boot()
  return app.fetch(new Request('http://localhost/touch'))
}

describe('AuthServiceProvider session resolution (RFC 0020)', () => {
  it('should write sessions through the store a bound SessionManager selects', async () => {
    const store = new MemorySessionStore()
    const write = spyOn(store, 'write')
    const app = createApp({ routes, auth: {}, providers: [sessionProvider(managerFor(store))] })

    const response = await touch(app)

    expect(response.status).toBe(200)
    expect(write).toHaveBeenCalledTimes(1)
    expect(response.headers.get('set-cookie')).toContain('guren.session=')
  })

  it('should take cookie settings from the manager, with auth.sessionOptions overriding field by field', async () => {
    const manager = managerFor(new MemorySessionStore(), { cookieName: 'from-manager', ttlSeconds: 10 })
    const app = createApp({
      routes,
      auth: { sessionOptions: { cookieName: 'from-auth' } },
      providers: [sessionProvider(manager)],
    })

    const response = await touch(app)

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
    const store = new MemorySessionStore()
    const write = spyOn(store, 'write')
    const app = createApp({ routes, auth: { sessionOptions: { store } } })

    await touch(app)

    expect(write).toHaveBeenCalledTimes(1)
  })

  it('should find a manager a deferred provider binds', async () => {
    const store = new MemorySessionStore()
    const write = spyOn(store, 'write')
    class DeferredSessionProvider extends ServiceProvider {
      static deferred = true
      static provides = ['session']
      register(): void {
        this.container.instance('session', managerFor(store))
      }
    }
    const app = createApp({ routes, auth: {}, providers: [DeferredSessionProvider] })

    await touch(app)

    expect(write).toHaveBeenCalledTimes(1)
  })

  it('should fail the boot when the default store names a driver nobody registered', async () => {
    const manager = new SessionManager({ default: 'redis', stores: { redis: { driver: 'redsi' } as never } })
    const app = createApp({ routes, auth: {}, providers: [sessionProvider(manager)] })

    await expect(app.boot()).rejects.toThrow('Unknown session driver: redsi (session store "redis")')
  })

  it('should fail the boot, not the first request, on a missing APP_KEY', async () => {
    const key = process.env.APP_KEY
    delete process.env.APP_KEY
    try {
      const app = createApp({ routes, auth: {} })
      await expect(app.boot()).rejects.toThrow('APP_KEY')
    } finally {
      process.env.APP_KEY = key
    }
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
