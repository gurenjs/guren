import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

/**
 * `stop()`'s Vite half, kept apart from `application-stop.test.ts` because it
 * needs a stubbed `startViteDevServer` and that file binds real sockets.
 *
 * The real module is spread and only `startViteDevServer` overridden: replacing
 * the module wholesale would strip its other exports for every test that loads
 * it afterwards in the same process.
 */
const viteCloseMock = mock(async () => {})

const startViteDevServerMock = mock(async () => ({
  server: {
    close: viteCloseMock,
    httpServer: { listening: true },
  },
  localUrl: 'http://localhost:5174',
  networkUrls: [],
}))

const realViteDevServer = await import('../../src/http/vite-dev-server')

await mock.module('../../src/http/vite-dev-server', () => ({
  ...realViteDevServer,
  startViteDevServer: startViteDevServerMock,
}))

const { Application } = await import('../../src/http/Application')

type GurenGlobal = typeof globalThis & {
  __gurenActiveServer?: unknown
  __gurenActiveViteDevServer?: unknown
  __gurenActiveViteDevServerUrl?: string
}

const globalState = globalThis as GurenGlobal

describe('Application.stop and the managed Vite dev server', () => {
  const originalEnv = { ...process.env }
  const originalServe = Bun.serve

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.NODE_ENV = 'development'
    process.env.GUREN_DEV_BANNER = '0'
    delete process.env.VITE_DEV_SERVER_URL
    delete process.env.GUREN_MANAGED_VITE_DEV_SERVER
    delete process.env.GUREN_INERTIA_ENTRY
    startViteDevServerMock.mockClear()
    viteCloseMock.mockClear()
    globalState.__gurenActiveServer = undefined
    globalState.__gurenActiveViteDevServer = undefined
    globalState.__gurenActiveViteDevServerUrl = undefined
    Bun.serve = mock(() => ({ stop: mock(async () => {}), port: 3400 })) as unknown as typeof Bun.serve
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Bun.serve = originalServe
    globalState.__gurenActiveServer = undefined
    globalState.__gurenActiveViteDevServer = undefined
    globalState.__gurenActiveViteDevServerUrl = undefined
  })

  it('closes the Vite dev server listen() started, and unpublishes its env vars', async () => {
    const app = new Application()
    await app.listen({ port: 3400, hostname: '127.0.0.1' })

    // Guard the premise: without a managed server actually started, the
    // assertions below would pass against an app that never had one.
    expect(startViteDevServerMock).toHaveBeenCalledTimes(1)
    expect(process.env.VITE_DEV_SERVER_URL).toBe('http://localhost:5174')
    expect(globalState.__gurenActiveViteDevServer).toBeDefined()

    await app.stop(true)

    expect(viteCloseMock).toHaveBeenCalledTimes(1)
    expect(globalState.__gurenActiveViteDevServer).toBeUndefined()
    expect(globalState.__gurenActiveViteDevServerUrl).toBeUndefined()
    // Leaving these set would point a later process at an asset server that is
    // no longer running.
    expect(process.env.VITE_DEV_SERVER_URL).toBeUndefined()
    expect(process.env.GUREN_MANAGED_VITE_DEV_SERVER).toBeUndefined()
    expect(process.env.GUREN_INERTIA_ENTRY).toBeUndefined()
  })

  it('leaves an app-supplied Inertia entry alone when it unpublishes its own', async () => {
    // `listen()` only overwrites the entry when it is unset or the managed
    // default, so stopping must not delete one the app chose for itself.
    process.env.GUREN_INERTIA_ENTRY = 'http://assets.example/custom-entry.ts'

    const app = new Application()
    await app.listen({ port: 3404, hostname: '127.0.0.1' })
    expect(process.env.GUREN_INERTIA_ENTRY).toBe('http://assets.example/custom-entry.ts')

    await app.stop(true)

    expect(process.env.GUREN_INERTIA_ENTRY).toBe('http://assets.example/custom-entry.ts')
  })

  it('starts a fresh Vite dev server when a stopped app listens again', async () => {
    const app = new Application()
    await app.listen({ port: 3401, hostname: '127.0.0.1' })
    await app.stop(true)

    // The reuse path checks `__gurenActiveViteDevServer`, which stop() cleared —
    // so the restart must start one rather than adopt a closed server.
    await app.listen({ port: 3401, hostname: '127.0.0.1' })

    expect(startViteDevServerMock).toHaveBeenCalledTimes(2)
    expect(process.env.VITE_DEV_SERVER_URL).toBe('http://localhost:5174')

    await app.stop(true)
  })

  /**
   * The listener-count case in `application-stop.test.ts` runs `vite: false`, so
   * it only ever watched the Bun half. This is the same guarantee on the half
   * that starts a *second* set of handlers — and where a close that only reset
   * a boolean used to leave the first set attached. The stale set is worse than
   * its count: its signal handler runs its own `process.exit()`, so it can end
   * the process before the live set has finished shutting down.
   */
  it('detaches the Vite teardown handlers too, across repeated cycles', async () => {
    const counts = () => ({
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    })

    const app = new Application()
    const before = counts()

    await app.listen({ port: 3403, hostname: '127.0.0.1' })
    const listening = counts()
    // Two sets while listening: the Bun half and the Vite half.
    expect(listening.exit).toBe(before.exit + 2)
    expect(listening.sigint).toBe(before.sigint + 2)
    expect(listening.sigterm).toBe(before.sigterm + 2)

    await app.stop(true)
    expect(counts()).toEqual(before)

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await app.listen({ port: 3403, hostname: '127.0.0.1' })
      expect(counts()).toEqual(listening)
      await app.stop(true)
      expect(counts()).toEqual(before)
    }
  })

  it('closes nothing extra when listen() started no Vite dev server', async () => {
    // An externally supplied asset URL means listen() starts nothing of its
    // own. It still clears the stale active server it found — that is
    // listen()'s existing behaviour, not stop()'s — so the assertion that
    // matters is that stop() adds no second close on top of it.
    const strayClose = mock(async () => {})
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:6000'
    globalState.__gurenActiveViteDevServer = { close: strayClose, httpServer: { listening: true } }
    globalState.__gurenActiveViteDevServerUrl = 'http://localhost:6000'

    const app = new Application()
    await app.listen({ port: 3402, hostname: '127.0.0.1' })

    expect(startViteDevServerMock).not.toHaveBeenCalled()
    const closesAfterListen = strayClose.mock.calls.length

    await app.stop(true)

    expect(strayClose.mock.calls.length).toBe(closesAfterListen)
  })
})
