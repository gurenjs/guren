import { describe, test, expect } from 'bun:test'
import { Container } from './Container'
import { ProviderManager, type ServiceProviderConstructor } from './ServiceProvider'
import { definePlugin } from './definePlugin'

interface FakeClientConfig {
  apiKey: string
}

class FakeClient {
  constructor(public config: FakeClientConfig) {}
}

const fakePlugin = definePlugin<FakeClientConfig>({
  name: 'fake-analytics',
  register(container, config) {
    container.singleton('fake-analytics', () => new FakeClient(config))
  },
})

async function bootWith(providers: ServiceProviderConstructor[]) {
  const container = new Container()
  const manager = new ProviderManager(container)
  manager.registerMany(providers)
  await manager.registerAll()
  await manager.bootAll()
  return { container, manager }
}

describe('definePlugin', () => {
  test('should register services with the captured config', async () => {
    const { container } = await bootWith([fakePlugin({ apiKey: 'key-1' })])

    const client = container.make<FakeClient>('fake-analytics')
    expect(client).toBeInstanceOf(FakeClient)
    expect(client.config.apiKey).toBe('key-1')
  })

  test('should isolate config between factory calls', async () => {
    const first = fakePlugin({ apiKey: 'first' })
    const second = fakePlugin({ apiKey: 'second' })

    const { container: containerA } = await bootWith([first])
    const { container: containerB } = await bootWith([second])

    expect(containerA.make<FakeClient>('fake-analytics').config.apiKey).toBe('first')
    expect(containerB.make<FakeClient>('fake-analytics').config.apiKey).toBe('second')
  })

  test('should run boot after register', async () => {
    const order: string[] = []
    const plugin = definePlugin({
      name: 'ordered',
      register() {
        order.push('register')
      },
      boot() {
        order.push('boot')
      },
    })

    await bootWith([plugin()])
    expect(order).toEqual(['register', 'boot'])
  })

  test('should pass the container to boot', async () => {
    const plugin = definePlugin<{ label: string }>({
      name: 'boot-access',
      register(container, config) {
        container.instance('label', config.label)
      },
      boot(container, config) {
        container.instance('booted-label', `${container.make<string>('label')}:${config.label}`)
      },
    })

    const { container } = await bootWith([plugin({ label: 'x' })])
    expect(container.make<string>('booted-label')).toBe('x:x')
  })

  test('should support deferred providers', async () => {
    let registered = false
    const plugin = definePlugin({
      name: 'lazy',
      deferred: true,
      provides: ['lazy-service'],
      register(container) {
        registered = true
        container.singleton('lazy-service', () => 'ready')
      },
    })

    const { container, manager } = await bootWith([plugin()])

    expect(registered).toBe(false)
    await manager.loadDeferredProvider('lazy-service')
    expect(registered).toBe(true)
    expect(container.make<string>('lazy-service')).toBe('ready')
  })

  test('should derive the provider class name from the plugin name', () => {
    const provider = fakePlugin({ apiKey: 'x' })
    expect(provider.name).toBe('fake-analyticsPluginProvider')
  })
})
