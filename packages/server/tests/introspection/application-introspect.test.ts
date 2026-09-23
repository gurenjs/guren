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
  requireAuthenticated,
  ServiceProvider,
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
    providers: [RecordingProvider, HookedProvider, ThrowingProvider, DeferredProvider],
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

    expect(app.router.describeMiddleware().aliases.web).toMatchObject({ members: ['auth', 'missing'], unresolvedMembers: ['missing'] })
    expect(app.router.describeMiddleware().aliases.auth?.unresolved).toBeUndefined()
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

      expect(manifest.providers.find((provider) => provider.name === 'ConfigServiceProvider')?.register).toBe('ran')
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
