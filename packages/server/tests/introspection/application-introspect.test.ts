import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod'
import {
  authorizeMiddleware,
  authorizeResourceMiddleware,
  CacheManager,
  Controller,
  createApp,
  defineEnv,
  defineModule,
  definePlugin,
  Env,
  QueueManager,
  requireAuthenticated,
  ServiceProvider,
  SessionManager,
  StorageManager,
  type AppManifest,
  type Router,
} from '../../src'
import { defineConfig } from '../../src/config/define'
import { resetDefaultApplication } from '../../src/http/default-application'
import { withEnv } from '../support/env'

afterEach(() => {
  resetDefaultApplication()
})

const lifecycle: string[] = []

class PostController extends Controller {
  async index() {
    return this.json([])
  }

  async update() {
    return this.json({})
  }
}

class InvoiceController extends Controller {
  async index() {
    return this.json([])
  }
}

class RecordingProvider extends ServiceProvider {
  register(): void {
    lifecycle.push('register')
    this.container.instance('recording', true)
  }

  override boot(): void {
    lifecycle.push('boot')
  }
}

class HookedProvider extends ServiceProvider {
  register(): void {
    lifecycle.push('hooked:register')
  }

  override introspect(): void {
    lifecycle.push('hooked:introspect')
    this.container.instance('hooked', 'described')
  }
}

class ThrowingProvider extends ServiceProvider {
  register(): void {
    throw new Error('env.DB is not bound')
  }
}

class LaterProvider extends ServiceProvider {
  register(): void {
    this.container.instance('later', true)
  }
}

class DeferredProvider extends ServiceProvider {
  static override deferred = true
  static override provides = ['deferred.service']

  register(): void {
    this.container.instance('deferred.service', true)
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

const billing = defineModule({
  name: 'billing',
  prefix: '/billing',
  providers: [LaterProvider],
  routes: (router) => {
    router.get('/invoices', [InvoiceController, 'index']).name('billing.invoices')
  },
})

function registerRoutes(baseRouter: Router): void {
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
    .aliasMiddleware('can-edit', authorizeMiddleware('update-post'))
    .groupMiddleware('web', ['auth', 'can-edit'])

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.middleware('web').group((web) => {
    web.put('/posts/:id', {
      name: 'posts.update',
      params: z.object({ id: z.coerce.number() }),
      body: z.object({ title: z.string().min(1) }),
    }, [PostController, 'update'])
  })
  router.delete('/posts/:id', [PostController, 'update'])
    .middleware(authorizeResourceMiddleware(() => ({})))
}

function fixtureApp(options: Parameters<typeof createApp>[0] = {}) {
  return createApp({
    routes: registerRoutes,
    providers: [RecordingProvider, HookedProvider, ThrowingProvider, DeferredProvider, ManagersProvider],
    modules: [billing],
    ...options,
  })
}

describe('Application.introspect()', () => {
  test('registers and mounts without booting, and returns a JSON-safe manifest', async () => {
    lifecycle.length = 0
    let bootCallbackRan = false
    const app = fixtureApp({ boot: () => { bootCallbackRan = true } })

    const manifest = await app.introspect()

    expect(lifecycle).toEqual(['register', 'hooked:introspect'])
    expect(bootCallbackRan).toBe(false)
    expect(manifest.warnings.map((warning) => warning.code)).toContain('boot-callback-skipped')
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.entry).toEqual({ file: null, root: process.cwd(), stage: 'register' })
    expect(JSON.parse(JSON.stringify(manifest)) as AppManifest).toEqual(manifest)
  })

  test('records every provider with its source and register outcome, continuing past a throw', async () => {
    const manifest = await fixtureApp().introspect()

    const byName = Object.fromEntries(manifest.providers.map((provider) => [provider.name, provider]))
    expect(byName.AuthorizationServiceProvider).toMatchObject({ source: 'framework', register: 'ran' })
    expect(byName.RecordingProvider).toMatchObject({ source: 'options.providers', register: 'ran' })
    expect(byName.HookedProvider).toMatchObject({ register: 'introspect-hook' })
    expect(byName.ThrowingProvider).toMatchObject({ register: 'threw', error: 'env.DB is not bound' })
    expect(byName.DeferredProvider).toMatchObject({ deferred: true, provides: ['deferred.service'], register: 'skipped' })
    expect(byName.LaterProvider).toMatchObject({ source: 'module', module: 'billing', register: 'ran' })
    expect(manifest.bindings).toContain('later')
    expect(manifest.bindings).toContain('hooked')
    expect(manifest.bindings).not.toContain('deferred.service')
  })

  test('returns the memoised manifest, and the introspected app refuses to boot', async () => {
    const app = createApp()

    const first = await app.introspect()

    expect(await app.introspect()).toBe(first)
    await expect(app.boot()).rejects.toThrow('This application was introspected')
  })

  test('refuses to introspect an app that booted', async () => {
    const app = createApp()
    await app.boot()

    await expect(app.introspect()).rejects.toThrow('Cannot introspect an application that has booted')
  })

  test('reports module provenance for routes and each module', async () => {
    const manifest = await fixtureApp().introspect()

    const invoices = manifest.routes.find((route) => route.name === 'billing.invoices')
    expect(invoices).toMatchObject({ path: '/billing/invoices', module: 'billing' })
    expect(manifest.routes.find((route) => route.name === 'posts.index')?.module).toBeNull()
    expect(manifest.modules).toEqual([
      { name: 'billing', prefix: '/billing', providers: ['LaterProvider'], commands: [], routeCount: 1 },
    ])
  })

  test('names controllers without claiming a file, which the CLI resolves by identity', async () => {
    const manifest = await fixtureApp().introspect()

    expect(manifest.routes.find((route) => route.name === 'posts.index')?.controller).toEqual({
      name: 'PostController',
      action: 'index',
      file: null,
      exportName: null,
      resolved: 'name-only',
    })
  })

  test('resolves aliases and groups into middleware entries with capabilities and abilities', async () => {
    const manifest = await fixtureApp().introspect()

    expect(manifest.middlewareAliases.web).toMatchObject({
      kind: 'group',
      name: 'web',
      members: ['auth', 'can-edit'],
      capabilities: { authentication: { mode: 'required' }, authorization: { abilities: ['update-post'], mode: 'all' } },
      ability: 'update-post',
    })
    expect(manifest.middlewareAliases.auth).toMatchObject({ kind: 'alias', capabilities: { authentication: { mode: 'required' } } })
    expect(manifest.middlewareAliases.auth?.ability).toBeUndefined()

    const update = manifest.routes.find((route) => route.name === 'posts.update')
    expect(update?.middleware.map((entry) => [entry.kind, entry.name])).toEqual([['group', 'web']])

    const destroy = manifest.routes.find((route) => route.method === 'DELETE')
    expect(destroy?.middleware).toHaveLength(1)
    expect(destroy?.middleware[0]).toMatchObject({ kind: 'inline', ability: 'delete' })
  })

  test('reports a middleware name nothing registers instead of throwing', () => {
    const app = createApp()
    app.router.middleware('missing' as never).group((router) => {
      router.get('/x', () => 'x')
    })

    const { routes } = app.router.describeMiddleware()

    expect(routes[0]).toEqual([{ kind: 'alias', name: 'missing', capabilities: {}, unresolved: true }])
  })

  test('carries route schemas as JSON Schema, and a non-Zod schema as unreadable', async () => {
    const app = createApp({
      routes: (router) => {
        router.post('/raw', { name: 'raw', body: { parse: (value: unknown) => value, safeParse: (value: unknown) => ({ success: true as const, data: value }) } }, () => 'ok')
      },
    })

    const [raw] = (await app.introspect()).routes
    const manifest = await fixtureApp().introspect()
    const update = manifest.routes.find((route) => route.name === 'posts.update')

    expect(update?.schemas.body).toMatchObject({ type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'] })
    expect(update?.schemas.params).toMatchObject({ type: 'object', properties: { id: { type: 'number' } } })
    expect(raw?.schemas.body).toEqual({ unreadable: expect.stringContaining('not a supported Zod schema') })
  })

  test('describes the managers without building a store or resolving a driver', async () => {
    const manifest = await fixtureApp().introspect()

    expect(manifest.session).toEqual({
      source: 'manager',
      default: 'redis',
      stores: { memory: { driver: 'memory', perProcess: true }, redis: { driver: 'redis', perProcess: false } },
    })
    expect(manifest.cache).toEqual({ default: 'redis', entries: { redis: { driver: 'redis' }, custom: { driver: null } } })
    expect(manifest.storage).toEqual({ default: 'media', entries: { media: { driver: 'memory' } } })
    expect(manifest.queue).toEqual({ default: 'sync', entries: { sync: { driver: null } } })
    expect(manifest.auth).toMatchObject({ guards: ['web'], defaultGuard: 'web', hasher: 'DefaultHasher', providers: {} })
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

  test('derives agent tools from the registered routes', async () => {
    const app = createApp({
      routes: (router) => {
        router.get('/posts', { name: 'posts.index', query: z.object({ page: z.number().optional() }) }, () => [])
          .agent({ readOnlyHint: true })
      },
    })

    const manifest = await app.introspect()

    expect(manifest.agentTools.map((tool) => tool.toolName)).toEqual(['posts.index'])
  })

  test('turns env problems and configs left unbound into manifest warnings (RFC 0027 §1)', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const app = createApp({
      env: defineEnv({ RFC26_REQUIRED_KEY: Env.string() }),
      config: [
        defineConfig({
          key: 'cache',
          resolve: (values) => ({ default: (values as unknown as Record<string, string>).RFC26_REQUIRED_KEY }),
          bind: () => {},
        }),
      ],
    })

    try {
      const manifest = await withEnv({ GUREN_INTROSPECT: '1', RFC26_REQUIRED_KEY: undefined }, () => app.introspect())

      expect(manifest.warnings).toContainEqual({ code: 'env-invalid', message: 'RFC26_REQUIRED_KEY required, not set', provider: 'ConfigServiceProvider' })
      expect(manifest.warnings.find((warning) => warning.code === 'config-unverified')).toMatchObject({ provider: 'ConfigServiceProvider' })
    } finally {
      warn.mockRestore()
    }
  })
})

describe('GUREN_INTROSPECT=1', () => {
  test('degrades boot() to introspect(): providers register, none boots', async () => {
    lifecycle.length = 0
    const app = createApp({ providers: [RecordingProvider] })

    await withEnv({ GUREN_INTROSPECT: '1' }, () => app.boot())

    expect(lifecycle).toEqual(['register'])
    expect((await app.introspect()).providers.some((provider) => provider.name === 'RecordingProvider')).toBe(true)
  })

  test('makes listen() throw with a code a reader can match across server copies', async () => {
    const app = createApp()

    const error = await withEnv({ GUREN_INTROSPECT: '1' }, () => app.listen({ port: 0 }).then(() => undefined, (caught: unknown) => caught))

    expect(error).toMatchObject({ code: 'GUREN_INTROSPECT_LISTEN' })
    expect(String(error)).toContain('GUREN_INTROSPECT=1')
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
    expect(manifest.providers.find((provider) => provider.name === 'plainPluginProvider')?.register).toBe('ran')
    expect(manifest.providers.find((provider) => provider.name === 'hookedPluginProvider')?.register).toBe('introspect-hook')
  })
})

describe('Router.registeredHandlers()', () => {
  test('is index-aligned with definitions() and keeps the controller class', () => {
    const app = createApp()
    app.router.get('/a', () => 'a')
    app.router.get('/posts', [PostController, 'index'])

    const handlers = app.router.registeredHandlers()
    const definitions = app.router.definitions()

    expect(handlers).toEqual([{ index: 0 }, { index: 1, controller: PostController, action: 'index' }])
    expect(definitions[1]?.controller).toEqual({ name: 'PostController', action: 'index' })
  })
})
