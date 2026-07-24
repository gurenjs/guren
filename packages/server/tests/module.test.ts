import { describe, expect, it } from 'bun:test'
import { Application, Controller, createApp, defineModule, ServiceProvider } from '../src'

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
})
