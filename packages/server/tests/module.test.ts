import { describe, expect, it } from 'bun:test'
import { Application, Controller, createApp, defineModule, mountModuleRoutes, Router, ServiceProvider } from '../src'

class BillingController extends Controller {
  async index() {
    const billingService = this.make<{ label: string }>('billing.service')
    return this.json({ label: billingService.label })
  }
}

class BillingServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('billing.service', () => ({ label: 'billing' }))
  }
}

describe('Application module wiring', () => {
  it('registers a module provider so its bindings resolve from the container', async () => {
    const billingModule = defineModule({
      name: 'billing',
      providers: [BillingServiceProvider],
    })
    const app = new Application({ modules: [billingModule] })
    await app.boot()

    expect(app.container.make<{ label: string }>('billing.service').label).toBe('billing')
  })

  it('mounts a module route registrar with no prefix', async () => {
    const billingModule = defineModule({
      name: 'billing',
      routes: (router) => {
        router.get('/invoices', [BillingController, 'index'])
      },
      providers: [BillingServiceProvider],
    })
    const app = new Application({ modules: [billingModule] })
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/invoices'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ label: 'billing' })
  })

  it('mounts a module route registrar under its declared prefix', async () => {
    const billingModule = defineModule({
      name: 'billing',
      prefix: '/billing',
      routes: (router) => {
        router.get('/invoices', [BillingController, 'index'])
      },
      providers: [BillingServiceProvider],
    })
    const app = new Application({ modules: [billingModule] })
    await app.boot()

    const prefixed = await app.fetch(new Request('http://example.com/billing/invoices'))
    expect(prefixed.status).toBe(200)

    const unprefixed = await app.fetch(new Request('http://example.com/invoices'))
    expect(unprefixed.status).toBe(404)
  })

  it('runs module routes alongside top-level routes registered via createApp()', async () => {
    const billingModule = defineModule({
      name: 'billing',
      prefix: '/billing',
      routes: (router) => {
        router.get('/invoices', [BillingController, 'index'])
      },
      providers: [BillingServiceProvider],
    })
    const app = createApp({
      routes: (router) => {
        router.get('/ping', () => 'pong')
      },
      modules: [billingModule],
    })
    await app.boot()

    const ping = await app.fetch(new Request('http://example.com/ping'))
    expect(await ping.text()).toBe('pong')

    const invoices = await app.fetch(new Request('http://example.com/billing/invoices'))
    expect(invoices.status).toBe(200)
  })

  it('supports multiple modules with independent prefixes', async () => {
    const billingModule = defineModule({
      name: 'billing',
      prefix: '/billing',
      routes: (router) => {
        router.get('/invoices', () => 'billing-invoices')
      },
    })
    const inventoryModule = defineModule({
      name: 'inventory',
      prefix: '/inventory',
      routes: (router) => {
        router.get('/items', () => 'inventory-items')
      },
    })
    const app = new Application({ modules: [billingModule, inventoryModule] })
    await app.boot()

    const billing = await app.fetch(new Request('http://example.com/billing/invoices'))
    expect(await billing.text()).toBe('billing-invoices')

    const inventory = await app.fetch(new Request('http://example.com/inventory/items'))
    expect(await inventory.text()).toBe('inventory-items')
  })

  it('normalizes providers to an empty array when a module declares none', async () => {
    const emptyModule = defineModule({ name: 'empty' })
    expect(emptyModule.providers).toEqual([])

    const app = new Application({ modules: [emptyModule] })
    await expect(app.boot()).resolves.toBeUndefined()
  })

  it('normalizes commands to an empty array when a module declares none', () => {
    // A console entrypoint calls `kernel.registerMany(module.commands)`
    // directly — an `undefined` here would be a runtime error, not a no-op.
    const emptyModule = defineModule({ name: 'empty' })
    expect(emptyModule.commands).toEqual([])
  })

  it('carries declared commands through to the module object', () => {
    class InvoiceCommand {
      static signature = 'invoice'
      static description = 'x'
      setInput(): void {}
      setOutput(): void {}
      setKernel(): void {}
      async run(): Promise<number> {
        return 0
      }
    }

    const billingModule = defineModule({ name: 'billing', commands: [InvoiceCommand] })
    expect(billingModule.commands).toEqual([InvoiceCommand])
  })
})

describe('mountModuleRoutes', () => {
  const moduleOf = (router: Router) => router.definitions().map((definition) => [definition.path, definition.module])

  it('names the module on each route its registrar added, and none on the app\'s own', async () => {
    const router = new Router()
    router.get('/posts', [BillingController, 'index'])
    await mountModuleRoutes(router, defineModule({
      name: 'billing',
      routes: (moduleRouter) => {
        moduleRouter.get('/invoices', [BillingController, 'index'])
      },
    }))
    await mountModuleRoutes(router, defineModule({
      name: 'shop',
      prefix: '/shop',
      routes: (moduleRouter) => {
        moduleRouter.group('/carts', (carts) => {
          carts.get('/', [BillingController, 'index'])
        })
      },
    }))

    expect(moduleOf(router)).toEqual([['/posts', undefined], ['/invoices', 'billing'], ['/shop/carts', 'shop']])
    expect('module' in router.definitions()[0]!).toBe(false)
  })

  it('names a route an async registrar adds after an await, once its prefix has popped', async () => {
    const router = new Router()
    await mountModuleRoutes(router, defineModule({
      name: 'billing',
      prefix: '/billing',
      routes: async (moduleRouter) => {
        moduleRouter.get('/before', [BillingController, 'index'])
        await Promise.resolve()
        moduleRouter.get('/after', [BillingController, 'index'])
      },
    }))

    expect(moduleOf(router)).toEqual([['/billing/before', 'billing'], ['/after', 'billing']])
  })

  it('names a module a registrar mounts itself after the module createApp() lists', async () => {
    const router = new Router()
    const inner = defineModule({
      name: 'invoices',
      routes: (moduleRouter) => {
        moduleRouter.get('/invoices', [BillingController, 'index'])
      },
    })
    await mountModuleRoutes(router, defineModule({
      name: 'billing',
      routes: async (moduleRouter) => {
        moduleRouter.get('/billing', [BillingController, 'index'])
        await mountModuleRoutes(moduleRouter, inner)
      },
    }))

    expect(moduleOf(router)).toEqual([['/billing', 'billing'], ['/invoices', 'billing']])
  })

  it('carries the name into the manifest for an unprefixed module', async () => {
    const manifest = await createApp({
      routes: (router) => {
        router.get('/posts', [BillingController, 'index'])
      },
      modules: [defineModule({
        name: 'billing',
        routes: (router) => {
          router.get('/invoices', [BillingController, 'index'])
        },
      })],
    }).introspect()

    expect(manifest.routes.map((route) => [route.path, route.module])).toEqual([['/posts', null], ['/invoices', 'billing']])
    expect(manifest.modules[0]?.routeCount).toBe(1)
  })
})
