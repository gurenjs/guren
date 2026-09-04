import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import {
  activeViteDevServer,
  createViteDevServerMocks,
  resetGurenGlobals,
  seedPreviousViteDevServer,
  signalListenerCounts,
} from './vite-dev-server-fixture'

/**
 * `stop()`'s Vite half, kept apart from `application-stop.test.ts` because it
 * needs a stubbed `startViteDevServer` and that file binds real sockets.
 */
const vite = createViteDevServerMocks()

await mock.module('../../src/http/vite-dev-server', vite.moduleFactory)

const { Application } = await import('../../src/http/Application')

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
    vite.clear()
    resetGurenGlobals()
    Bun.serve = mock(() => ({ stop: mock(async () => {}), port: 3400 })) as unknown as typeof Bun.serve
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Bun.serve = originalServe
    resetGurenGlobals()
  })

  it('closes the Vite dev server listen() started, and unpublishes its env vars', async () => {
    const app = new Application()
    await app.listen({ port: 3400, hostname: '127.0.0.1' })

    // Guard the premise: without a managed server actually started, the
    // assertions below would pass against an app that never had one.
    expect(vite.startViteDevServer).toHaveBeenCalledTimes(1)
    expect(process.env.VITE_DEV_SERVER_URL).toBe('http://localhost:5174')
    expect(activeViteDevServer()).toBeDefined()

    await app.stop(true)

    expect(vite.viteClose).toHaveBeenCalledTimes(1)
    expect(activeViteDevServer()).toBeUndefined()
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

    expect(vite.startViteDevServer).toHaveBeenCalledTimes(2)
    expect(process.env.VITE_DEV_SERVER_URL).toBe('http://localhost:5174')

    await app.stop(true)
  })

  /**
   * The listener-count guarantee on the Vite half, which starts a *second* set of
   * handlers. A stale set is worse than its count: its signal handler runs its own
   * `process.exit()`, ending the process before the live set finishes.
   */
  it('detaches the Vite teardown handlers too, across repeated cycles', async () => {
    const app = new Application()
    const before = signalListenerCounts()

    await app.listen({ port: 3403, hostname: '127.0.0.1' })
    const listening = signalListenerCounts()
    // Two sets while listening: the Bun half and the Vite half.
    expect(listening.exit).toBe(before.exit + 2)
    expect(listening.sigint).toBe(before.sigint + 2)
    expect(listening.sigterm).toBe(before.sigterm + 2)

    await app.stop(true)
    expect(signalListenerCounts()).toEqual(before)

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await app.listen({ port: 3403, hostname: '127.0.0.1' })
      expect(signalListenerCounts()).toEqual(listening)
      await app.stop(true)
      expect(signalListenerCounts()).toEqual(before)
    }
  })

  it('closes nothing extra when listen() started no Vite dev server', async () => {
    // An externally supplied asset URL means listen() starts nothing of its own,
    // though it still clears the stale active server: stop() must add no second close.
    const strayClose = mock(async () => {})
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:6000'
    seedPreviousViteDevServer(
      { close: strayClose, httpServer: { listening: true } },
      'http://localhost:6000',
    )

    const app = new Application()
    await app.listen({ port: 3402, hostname: '127.0.0.1' })

    expect(vite.startViteDevServer).not.toHaveBeenCalled()
    const closesAfterListen = strayClose.mock.calls.length

    await app.stop(true)

    expect(strayClose.mock.calls.length).toBe(closesAfterListen)
  })
})
