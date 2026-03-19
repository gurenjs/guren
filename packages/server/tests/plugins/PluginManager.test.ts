import { describe, expect, it, mock } from 'bun:test'
import { ApplicationContext } from '../../src/plugins/ApplicationContext'
import { PluginManager } from '../../src/plugins/PluginManager'

describe('PluginManager', () => {
  it('registers and boots providers once', async () => {
    const register = mock(async () => {})
    const boot = mock(async () => {})

    class TestProvider {
      register = register
      boot = boot
    }

    const manager = new PluginManager(() => new ApplicationContext({ hono: {} } as any, {} as any))
    manager.add(TestProvider)

    await manager.registerAll()
    await manager.registerAll()
    await manager.bootAll()
    await manager.bootAll()

    expect(register).toHaveBeenCalledTimes(1)
    expect(boot).toHaveBeenCalledTimes(1)
  })

  it('rejects providers added after boot', async () => {
    const manager = new PluginManager(() => new ApplicationContext({ hono: {} } as any, {} as any))
    await manager.bootAll()

    expect(() => manager.add({} as any)).toThrow('Cannot register providers after application has booted')
  })
})

describe('ApplicationContext', () => {
  it('exposes application helpers', () => {
    const app = { hono: { name: 'hono' } } as any
    const auth = { name: 'auth' } as any
    const context = new ApplicationContext(app, auth)

    expect(context.app).toBe(app)
    expect(context.hono).toBe(app.hono)
    expect(context.auth).toBe(auth)
  })
})
