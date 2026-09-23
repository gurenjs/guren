import { afterEach, describe, expect, test } from 'bun:test'
import {
  authorizeMiddleware,
  authorizeResourceMiddleware,
  CacheManager,
  Controller,
  createApp,
  definePlugin,
  MemorySessionStore,
  QueueManager,
  requireAuthenticated,
  ServiceProvider,
  SessionManager,
  StorageManager,
} from '../../src'
import { resetDefaultApplication } from '../../src/http/default-application'

afterEach(() => {
  resetDefaultApplication()
})

class PostController extends Controller {
  async update() {
    return this.json({})
  }
}

class ManagersProvider extends ServiceProvider {
  register(): void {
    this.container.instance('session', new SessionManager({
      default: 'redis',
      stores: { redis: { driver: 'redis', client: () => { throw new Error('connected') } } },
    }))
    const cache = new CacheManager({ default: 'redis', stores: { redis: { driver: 'redis', client: () => { throw new Error('connected') } } } })
    cache.registerStore('custom', () => { throw new Error('built') })
    this.container.instance('cache', cache)
    this.container.instance('storage', new StorageManager({ default: 'media', disks: { media: { driver: 'memory' } } }))
    this.container.instance('queue', new QueueManager({ default: 'sync', drivers: { sync: () => { throw new Error('resolved') } } }))
  }
}

class ThrowingProvider extends ServiceProvider {
  register(): void {
    throw new Error('env.DB is not bound')
  }
}

describe('manager sections (RFC 0026 §1)', () => {
  test('describes the managers without building a store or resolving a driver', async () => {
    const manifest = await createApp({ providers: [ManagersProvider] }).introspect()

    expect(manifest.session).toEqual({
      source: 'manager',
      default: 'redis',
      stores: { memory: { driver: 'memory', perProcess: true }, redis: { driver: 'redis', perProcess: false } },
    })
    expect(manifest.cache).toEqual({ default: 'redis', entries: { redis: { driver: 'redis' }, custom: { driver: null } } })
    expect(manifest.storage).toEqual({ default: 'media', entries: { media: { driver: 'memory' } } })
    expect(manifest.queue).toEqual({ default: 'sync', entries: { sync: { driver: null } } })
    expect(manifest.auth).toEqual({ guards: ['web'], defaultGuard: 'web', hasher: 'DefaultHasher', providers: {} })
    expect(manifest.attachments).toBeUndefined()
  })

  test('reports the in-memory session the auth middleware falls back to when nothing configures one', async () => {
    const manifest = await createApp({ auth: {} }).introspect()

    expect(manifest.session).toEqual({ source: 'none', default: 'memory', stores: { memory: { driver: 'memory', perProcess: true } } })
  })

  test('never claims the in-memory fallback while the session binding is unverified', async () => {
    class DeferredSessionProvider extends ServiceProvider {
      static override deferred = true
      static override provides = ['session']

      register(): void {
        this.container.instance('session', new SessionManager())
      }
    }

    const deferred = await createApp({ auth: {}, providers: [DeferredSessionProvider] }).introspect()
    const thrown = await createApp({ auth: {}, providers: [ThrowingProvider] }).introspect()

    expect(deferred.session).toBeUndefined()
    expect(deferred.warnings).toContainEqual(expect.objectContaining({ code: 'section-unverified', provider: 'DeferredSessionProvider' }))
    expect(thrown.session).toBeUndefined()
    expect(thrown.warnings.find((warning) => warning.code === 'section-unverified')?.message).toContain('ThrowingProvider')
    expect(thrown.warnings.map((warning) => warning.message)).toContainEqual(expect.stringContaining('"cache" is unbound'))
  })

  test('warns when a session binding and an explicit store both configure sessions', async () => {
    class SessionProvider extends ServiceProvider {
      register(): void {
        this.container.instance('session', new SessionManager())
      }
    }

    const manifest = await createApp({ auth: { sessionOptions: { store: new MemorySessionStore() } }, providers: [SessionProvider] }).introspect()

    expect(manifest.session?.source).toBe('manager')
    expect(manifest.warnings.map((warning) => warning.code)).toContain('session-configured-twice')
  })

  test('answers perProcess only for the store classes the framework ships', async () => {
    class InProcessStore extends MemorySessionStore {}

    const shipped = await createApp({ auth: { sessionOptions: { store: new MemorySessionStore() } } }).introspect()
    const custom = await createApp({ auth: { sessionOptions: { store: new InProcessStore() } } }).introspect()

    expect(shipped.session?.stores['sessionOptions.store']).toEqual({ driver: 'MemorySessionStore', perProcess: true })
    expect(custom.session?.stores['sessionOptions.store']).toEqual({ driver: 'InProcessStore', perProcess: null })
  })

  test('never falls back to the in-memory session when the bound manager cannot be built', async () => {
    class BrokenSessionProvider extends ServiceProvider {
      register(): void {
        this.container.singleton('session', () => new SessionManager({ default: 'missing' }))
      }
    }

    const manifest = await createApp({ auth: {}, providers: [BrokenSessionProvider] }).introspect()

    expect(manifest.session).toBeUndefined()
    expect(manifest.warnings.find((warning) => warning.code === 'section-unreadable')?.message).toContain('Session store not found: missing')
  })

  test('reports a plugin session driver as unverifiable rather than shared', () => {
    const manager = new SessionManager({ default: 'dynamo', stores: { dynamo: { driver: 'dynamo' as 'memory' } } })

    expect(manager.describe().stores.dynamo).toEqual({ driver: 'dynamo', perProcess: null })
  })
})

describe('ability on middleware entries', () => {
  test('names the one ability a check or a resource check resolves to', async () => {
    const app = createApp({
      routes: (baseRouter) => {
        const router = baseRouter
          .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
          .aliasMiddleware('can-edit', authorizeMiddleware('update-post'))
          .aliasMiddleware('can-any', authorizeMiddleware(['a', 'b']))
          .aliasMiddleware('can-resource', authorizeResourceMiddleware(() => ({})))
          .groupMiddleware('web', ['auth', 'can-edit'])
          .groupMiddleware('mixed', ['can-edit', 'can-resource'])
        router.delete('/posts/:id', [PostController, 'update']).middleware(authorizeResourceMiddleware(() => ({})))
      },
    })

    const manifest = await app.introspect()

    expect(manifest.middlewareAliases.web?.ability).toBe('update-post')
    expect(manifest.middlewareAliases['can-edit']?.ability).toBe('update-post')
    expect(manifest.middlewareAliases['can-any']?.ability).toBeUndefined()
    expect(manifest.middlewareAliases.mixed?.ability).toBeUndefined()
    expect(manifest.middlewareAliases.auth?.ability).toBeUndefined()
    expect(manifest.routes[0]?.middleware[0]).toMatchObject({ kind: 'inline', ability: 'delete' })
  })
})

describe('definePlugin() introspection', () => {
  test('runs the hook only for a plugin that defines one', async () => {
    const calls: string[] = []
    const plain = definePlugin({ name: 'plain', register: () => { calls.push('plain:register') } })
    const hooked = definePlugin({
      name: 'hooked',
      register: () => { calls.push('hooked:register') },
      introspect: (container) => {
        calls.push('hooked:introspect')
        container.instance('hooked.plugin', true)
      },
    })

    const manifest = await createApp({ providers: [plain(undefined), hooked(undefined)] }).introspect()

    expect(calls).toEqual(['plain:register', 'hooked:introspect'])
    expect(manifest.bindings).toContain('hooked.plugin')
    expect(manifest.providers.find((provider) => provider.name === 'plainPluginProvider')?.register).toBe('ran')
    expect(manifest.providers.find((provider) => provider.name === 'hookedPluginProvider')?.register).toBe('introspect-hook')
  })
})
