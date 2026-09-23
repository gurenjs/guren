import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod'
import {
  authorizeMiddleware,
  authorizeResourceMiddleware,
  Controller,
  createApp,
  defineEnv,
  defineModule,
  Env,
  isIntrospecting,
  requireAuthenticated,
  ServiceProvider,
  type AppManifest,
  type Router,
} from '../../src'
import { Container } from '../../src/container/Container'
import { ProviderManager } from '../../src/container/ServiceProvider'
import { defineConfig } from '../../src/config/define'
import { toPlainJson } from '../../src/introspection/plain-json'
import { toJsonSchema } from '../../src/internal/zod-json-schema'
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

  async show() {
    return this.json({})
  }

  async store() {
    return this.json({})
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
  // All-optional: no `required` key, which the walker must omit rather than set to undefined.
  router.get('/search', { name: 'search', query: z.object({ q: z.string().optional() }) }, () => 'ok')
}

function fixtureApp(options: Parameters<typeof createApp>[0] = {}) {
  return createApp({
    routes: registerRoutes,
    providers: [RecordingProvider, HookedProvider, ThrowingProvider, DeferredProvider],
    modules: [billing],
    ...options,
  })
}

describe('Application.introspect()', () => {
  test('registers without mounting or booting, and returns a JSON-safe manifest', async () => {
    lifecycle.length = 0
    let bootCallbackRan = false
    const app = fixtureApp({ boot: () => { bootCallbackRan = true } })

    const manifest = await app.introspect()

    expect(lifecycle).toEqual(['register', 'hooked:introspect'])
    expect(bootCallbackRan).toBe(false)
    expect(manifest.warnings.map((warning) => warning.code)).toContain('boot-callback-skipped')
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.entry).toEqual({ file: null, root: process.cwd(), stage: 'register' })
    expect(JSON.parse(JSON.stringify(manifest)) as AppManifest).toStrictEqual(manifest)
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

  test('refuses to introspect an app whose boot failed part way', async () => {
    const app = createApp({ boot: () => { throw new Error('boot callback failed') } })
    await expect(app.boot()).rejects.toThrow('boot callback failed')

    await expect(app.introspect()).rejects.toThrow('Cannot introspect an application that has booted')
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

  test('resolves aliases and groups into middleware entries with capabilities', async () => {
    const manifest = await fixtureApp().introspect()

    expect(manifest.middlewareAliases.web).toMatchObject({
      kind: 'group',
      name: 'web',
      members: ['auth', 'can-edit'],
      capabilities: { authentication: { mode: 'required' }, authorization: { abilities: ['update-post'], mode: 'all' } },
    })
    expect(manifest.middlewareAliases.auth).toMatchObject({ kind: 'alias', capabilities: { authentication: { mode: 'required' } } })

    const update = manifest.routes.find((route) => route.name === 'posts.update')
    expect(update?.middleware.map((entry) => [entry.kind, entry.name])).toEqual([['group', 'web']])

    const destroy = manifest.routes.find((route) => route.method === 'DELETE')
    expect(destroy?.middleware).toHaveLength(1)
    expect(destroy?.middleware[0]).toMatchObject({ kind: 'inline', capabilities: { authorization: { resource: { fromMethodMap: true } } } })
  })

  test('names the members of a group that no alias registers', () => {
    const app = createApp()
    const router = app.router.aliasMiddleware('auth', requireAuthenticated()).groupMiddleware('web', ['auth', 'missing' as 'auth'])
    router.middleware('web').group((web) => {
      web.get('/x', () => 'x')
    })

    const { aliases } = app.router.describeMiddleware()

    expect(aliases.web).toMatchObject({ members: ['auth', 'missing'], unresolvedMembers: ['missing'] })
    expect(aliases.auth?.unresolved).toBeUndefined()
  })

  test('reports a middleware name nothing registers instead of throwing', async () => {
    const app = createApp({
      routes: (router) => {
        router.middleware('missing' as never).group((scoped) => {
          scoped.get('/x', () => 'x')
        })
      },
    })

    const [route] = (await app.introspect()).routes

    expect(route?.middleware).toEqual([{ kind: 'alias', name: 'missing', capabilities: {}, unresolved: true }])
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

  test('reports env problems in process too, instead of recording the config provider as thrown', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const app = createApp({ env: defineEnv({ RFC26_IN_PROCESS_KEY: Env.string() }) })

      const manifest = await withEnv({ GUREN_INTROSPECT: undefined, RFC26_IN_PROCESS_KEY: undefined }, () => app.introspect())

      expect(manifest.providers.find((provider) => provider.name === 'ConfigServiceProvider')?.register).toBe('introspect-hook')
      expect(manifest.warnings).toContainEqual({ code: 'env-invalid', message: 'RFC26_IN_PROCESS_KEY required, not set', provider: 'ConfigServiceProvider' })
    } finally {
      warn.mockRestore()
    }
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

describe('isIntrospecting()', () => {
  class FlagReadingProvider extends ServiceProvider {
    static seen: boolean[] = []

    register(): void {
      FlagReadingProvider.seen.push(isIntrospecting())
    }
  }

  class TickingFlagProvider extends ServiceProvider {
    static seen: Array<[string, boolean]> = []

    async register(): Promise<void> {
      const label = this.container.make<string>('label')
      await new Promise((resolve) => setTimeout(resolve, 0))
      TickingFlagProvider.seen.push([label, isIntrospecting()])
    }
  }

  const labelled = (label: string) => class extends ServiceProvider {
    register(): void {
      this.container.instance('label', label)
    }
  }

  test('is true inside an in-process introspect() and false for a normal boot()', async () => {
    FlagReadingProvider.seen = []

    await createApp({ providers: [FlagReadingProvider] }).introspect()
    await createApp({ providers: [FlagReadingProvider] }).boot()

    expect(FlagReadingProvider.seen).toEqual([true, false])
    expect(isIntrospecting()).toBe(false)
  })

  test('is not seen by another app booting while one introspects', async () => {
    TickingFlagProvider.seen = []
    const introspected = createApp({ providers: [labelled('introspect'), TickingFlagProvider] })
    const booted = createApp({ providers: [labelled('boot'), TickingFlagProvider] })

    await Promise.all([introspected.introspect(), booted.boot()])

    expect(Object.fromEntries(TickingFlagProvider.seen)).toEqual({ introspect: true, boot: false })
  })

  test('a normal boot() never calls a provider\'s introspect hook', async () => {
    lifecycle.length = 0

    await createApp({ providers: [HookedProvider] }).boot()

    expect(lifecycle).toEqual(['hooked:register'])
  })

  test('the same provider instance registered twice keeps its first outcome, origin and warnings', async () => {
    class WarningProvider extends HookedProvider {
      manifestWarnings() {
        return [{ code: 'example', message: 'once' }]
      }
    }
    const container = new Container()
    const manager = new ProviderManager(container)
    const hooked = new WarningProvider(container)
    manager.register(hooked, { source: 'module', module: 'billing' }).register(hooked, { source: 'app.register' })

    const providers = await manager.registerAllForIntrospection()

    expect(providers.filter((provider) => provider.name === 'WarningProvider')).toEqual([
      expect.objectContaining({ source: 'module', module: 'billing', register: 'introspect-hook' }),
    ])
    expect(manager.manifestWarnings()).toEqual([{ code: 'example', message: 'once', provider: 'WarningProvider' }])
  })
})

describe('toJsonSchema()', () => {
  test('omits `required` on an all-optional object instead of setting it to undefined', () => {
    const schema = toJsonSchema(z.object({ q: z.string().optional() }), [], 'query', 'input')

    expect(schema).toStrictEqual({ type: 'object', properties: { q: { type: 'string' } } })
  })
})

describe('toPlainJson()', () => {
  test('drops undefined keys and refuses what JSON cannot carry', () => {
    expect(toPlainJson<unknown>({ a: 1, b: undefined, c: [{ d: undefined }] })).toStrictEqual({ a: 1, c: [{}] })
    expect(() => toPlainJson({ routes: new Map() })).toThrow('manifest.routes is a Map')
    expect(() => toPlainJson({ hook: () => {} })).toThrow('manifest.hook is a function')
    expect(() => toPlainJson({ controller: new InvoiceController() })).toThrow('manifest.controller is a InvoiceController')
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

    let error: unknown
    try {
      error = await withEnv({ GUREN_INTROSPECT: '1' }, () => app.listen({ port: 0, vite: false }).then(() => undefined, (caught: unknown) => caught))
    } finally {
      await app.stop(true)
    }

    expect(error).toMatchObject({ code: 'GUREN_INTROSPECT_LISTEN' })
    expect(String(error)).toContain('GUREN_INTROSPECT=1')
  })
})

describe('Router.registeredHandlers()', () => {
  test('is index-aligned with definitions() under a group prefix and a resource() expansion', () => {
    const app = createApp()
    app.router.get('/a', () => 'a')
    app.router.group('/admin', (admin) => {
      admin.get('/posts', [PostController, 'index'])
      admin.resource('/invoices', InvoiceController)
    })

    const handlers = app.router.registeredHandlers()
    const definitions = app.router.definitions()

    expect(handlers.map((handler) => handler.index)).toEqual(definitions.map((_, index) => index))
    expect(handlers[0]).toEqual({ index: 0 })
    expect(handlers[1]).toEqual({ index: 1, controller: PostController, action: 'index' })
    expect(definitions.map((definition) => `${definition.method} ${definition.path}`)).toEqual([
      'GET /a', 'GET /admin/posts', 'GET /admin/invoices', 'POST /admin/invoices', 'GET /admin/invoices/:id',
    ])
    handlers.forEach((handler, index) => {
      expect(handler.controller?.name).toBe(definitions[index]?.controller?.name)
      expect(handler.action).toBe(definitions[index]?.controller?.action)
    })
  })
})
