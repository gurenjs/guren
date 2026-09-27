import { describe, expect, it, spyOn } from 'bun:test'
import { Application, defineModule, ServiceProvider } from '../src'
import { McpServiceProvider } from '../src/mcp/McpServiceProvider'
import { DocsViewerServiceProvider } from '../src/docs-viewer/DocsViewerServiceProvider'

describe('Application boot progress after failure', () => {
  it('does not repeat completed hooks or mounted routes after a provider boot fails', async () => {
    const failure = new Error('provider unavailable')
    let registrations = 0
    let completedBoots = 0
    let attempts = 0
    let callbacks = 0
    let requests = 0
    class ReadyProvider extends ServiceProvider {
      register() { registrations++ }
      boot() { completedBoots++ }
    }
    class RetryingProvider extends ServiceProvider {
      register() { registrations++ }
      boot() { if (++attempts === 1) throw failure }
    }
    const app = new Application({
      providers: [ReadyProvider, RetryingProvider],
      boot(hono) {
        callbacks++
        hono.use('*', async (_ctx, next) => { requests++; await next() })
      },
      routes(router) { router.get('/ping', () => new Response('pong')) },
    })
    const failures = await Promise.allSettled([app.boot(), app.boot()])
    expect(failures).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ])
    const mounted = app.hono.routes.length
    await Promise.all([app.boot(), app.boot(), app.booted()])
    expect(callbacks).toBe(1)
    expect(registrations).toBe(2)
    expect(completedBoots).toBe(1)
    expect(attempts).toBe(2)
    expect(app.hono.routes.length).toBe(mounted)
    expect(await (await app.fetch(new Request('http://localhost/ping'))).text()).toBe('pong')
    expect(requests).toBe(1)
    await expect(app.introspect()).rejects.toThrow('Cannot introspect')
  })

  it('keeps completed route registrars when a later module fails', async () => {
    let rootCalls = 0
    let firstCalls = 0
    let lastCalls = 0
    const app = new Application({
      routes(router) {
        rootCalls++
        router.get('/root', () => new Response('root'))
      },
      modules: [
        defineModule({ name: 'first', routes(router) {
          firstCalls++
          router.get('/first', () => new Response('first'))
        } }),
        defineModule({ name: 'last', routes(router) {
          if (++lastCalls === 1) throw new Error('routes unavailable')
          router.get('/last', () => new Response('last'))
        } }),
      ],
    })
    await expect(app.boot()).rejects.toThrow('routes unavailable')
    await app.boot()
    expect([rootCalls, firstCalls, lastCalls]).toEqual([1, 1, 2])
    expect(app.router.routeCount).toBe(3)
    for (const path of ['/root', '/first', '/last']) {
      expect((await app.fetch(new Request(`http://localhost${path}`))).status).toBe(200)
    }
  })

  it('does not partially mount routes when a later middleware alias is invalid', async () => {
    const app = new Application({ routes(router) {
      router.get('/ready', () => new Response('ready'))
      // The alias can be supplied by a provider or repaired before retrying.
      router.middleware('missing' as never).group((group) => {
        group.get('/guarded', () => new Response('guarded'))
      })
    } })
    await expect(app.boot()).rejects.toThrow()
    expect(app.hono.routes.some((route) => route.path === '/ready')).toBe(false)
    app.router.aliasMiddleware('missing', async (_ctx, next) => { await next() })
    await app.boot()
    expect(app.hono.routes.filter((route) => route.path === '/ready')).toHaveLength(1)
    expect((await app.fetch(new Request('http://localhost/guarded'))).status).toBe(200)
  })

  it('retries a failed hook, without pretending to roll back its own effects', async () => {
    let attempts = 0
    const effects: number[] = []
    const app = new Application({ boot() {
      effects.push(++attempts)
      if (attempts === 1) throw new Error('try again')
    } })
    await expect(app.boot()).rejects.toThrow('try again')
    await app.boot()
    await app.boot()
    expect(effects).toEqual([1, 2])
  })
})

it('registers a provider supplied after an unsuccessful boot before resuming', async () => {
  let attempts = 0
  let registrations = 0
  let boots = 0
  class AddedProvider extends ServiceProvider {
    register() { registrations++ }
    boot() { boots++ }
  }
  const app = new Application({ boot() {
    if (++attempts === 1) throw new Error('dependency missing')
  } })
  await expect(app.boot()).rejects.toThrow('dependency missing')
  app.register(AddedProvider)
  await app.boot()
  expect(registrations).toBe(1)
  expect(boots).toBe(1)
})

for (const failingStep of ['mcp', 'docs', 'provider'] as const) {
  it(`keeps completed dev endpoints when ${failingStep} fails`, async () => {
    const env = { NODE_ENV: process.env.NODE_ENV, GUREN_MCP: process.env.GUREN_MCP, GUREN_DOCS: process.env.GUREN_DOCS }
    process.env.NODE_ENV = 'development'
    process.env.GUREN_MCP = '1'
    process.env.GUREN_DOCS = '1'
    const calls = { mcp: 0, docs: 0, provider: 0 }
    const run = (step: keyof typeof calls) => {
      if (++calls[step] === 1 && step === failingStep) throw new Error(`${step} unavailable`)
    }
    const mcp = spyOn(McpServiceProvider.prototype, 'boot').mockImplementation(async () => { run('mcp') })
    const docs = spyOn(DocsViewerServiceProvider.prototype, 'boot').mockImplementation(async () => { run('docs') })
    try {
      class LastProvider extends ServiceProvider {
        register() {}
        boot() { run('provider') }
      }
      const app = new Application({ providers: [LastProvider] })
      await expect(app.boot()).rejects.toThrow(`${failingStep} unavailable`)
      await app.boot()
      expect(calls).toEqual({
        mcp: failingStep === 'mcp' ? 2 : 1,
        docs: failingStep === 'docs' ? 2 : 1,
        provider: failingStep === 'provider' ? 2 : 1,
      })
    } finally {
      mcp.mockRestore()
      docs.mockRestore()
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
}

it('shares an asynchronous retry and keeps booted waiting for that attempt', async () => {
  let attempts = 0
  let release!: () => void
  let started!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  const app = new Application({ async boot() {
    if (++attempts === 1) throw new Error('unavailable')
    started()
    await blocked
  } })
  await expect(app.boot()).rejects.toThrow('unavailable')
  const first = app.boot()
  const second = app.boot()
  await entered
  let settled = false
  const observer = app.booted().then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  release()
  await Promise.all([first, second, observer])
  expect(settled).toBe(true)
  expect(attempts).toBe(2)
})
