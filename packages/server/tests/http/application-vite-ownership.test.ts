import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import {
  activeViteDevServer,
  createViteDevServerMocks,
  resetGurenGlobals,
  seedPreviousViteDevServer,
  signalListenerCounts,
} from './vite-dev-server-fixture'

/**
 * Who may close the managed Vite dev server once a second `listen()` has adopted
 * it. Adoption is the `bun --hot` path, and both applications end up holding the
 * same server object — so ownership is answered by the active-server slot naming
 * one owner, not by comparing references.
 */
const vite = createViteDevServerMocks()

await mock.module('../../src/http/vite-dev-server', vite.moduleFactory)

const { Application } = await import('../../src/http/Application')

describe('managed Vite dev server ownership across listen() adoption', () => {
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
    Bun.serve = mock(() => ({
      stop: mock(async () => {}),
      port: 3500,
    })) as unknown as typeof Bun.serve
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Bun.serve = originalServe
    resetGurenGlobals()
  })

  /**
   * A and B both hold the adopted server, so A's `stop()` must not close it out
   * from under B, which is serving from its port and published env vars.
   */
  it('leaves the dev server alone when a later listen() has adopted it', async () => {
    const a = new Application()
    await a.listen({ port: 3500, hostname: '127.0.0.1' })
    expect(vite.startViteDevServer).toHaveBeenCalledTimes(1)
    const devServer = activeViteDevServer()?.server

    const b = new Application()
    await b.listen({ port: 3500, hostname: '127.0.0.1' })

    // Guard the premise: B adopted A's server rather than starting its own.
    expect(vite.startViteDevServer).toHaveBeenCalledTimes(1)
    expect(activeViteDevServer()?.server).toBe(devServer)

    await a.stop(true)

    expect(vite.viteClose).not.toHaveBeenCalled()
    expect(activeViteDevServer()?.server).toBe(devServer)
    expect(activeViteDevServer()?.localUrl).toBe('http://localhost:5174')
    // B is still serving assets from it, so the env vars must still point there.
    expect(process.env.VITE_DEV_SERVER_URL).toBe('http://localhost:5174')
    expect(process.env.GUREN_MANAGED_VITE_DEV_SERVER).toBe('1')

    await b.stop(true)
  })

  it('still closes it for the app that owns it after adoption', async () => {
    // The other half of the guard: narrowing who may close must not stop the
    // owner from closing. Without this, "nobody closes it" would pass above.
    const a = new Application()
    await a.listen({ port: 3501, hostname: '127.0.0.1' })

    const b = new Application()
    await b.listen({ port: 3501, hostname: '127.0.0.1' })

    await a.stop(true)
    await b.stop(true)

    expect(vite.viteClose).toHaveBeenCalledTimes(1)
    expect(activeViteDevServer()).toBeUndefined()
    expect(process.env.VITE_DEV_SERVER_URL).toBeUndefined()
    expect(process.env.GUREN_MANAGED_VITE_DEV_SERVER).toBeUndefined()
  })

  /**
   * Ownership has to carry the teardown handlers with it. A set left attached
   * to the outgoing owner runs its own `process.exit()` on the next signal, so
   * it can end the process ahead of the live owner's shutdown.
   */
  it('moves the Vite teardown handlers to the adopting app', async () => {
    const before = signalListenerCounts()

    const a = new Application()
    await a.listen({ port: 3502, hostname: '127.0.0.1' })
    // One Bun set and one Vite set.
    const oneApp = signalListenerCounts()
    expect(oneApp.sigint).toBe(before.sigint + 2)

    const b = new Application()
    await b.listen({ port: 3502, hostname: '127.0.0.1' })

    // B's two sets, plus A's Bun set — but not a second Vite set, because
    // adoption detached A's.
    expect(signalListenerCounts().sigint).toBe(before.sigint + 3)

    await a.stop(true)
    await b.stop(true)
    expect(signalListenerCounts()).toEqual(before)
  })

  /**
   * A released owner must be able to start over: a field left truthy-but-spent
   * makes the registrar's early return skip re-attaching on the next `listen()`,
   * leaving that app's Vite server with no teardown at all.
   */
  it('re-attaches teardown when a released app listens again', async () => {
    const before = signalListenerCounts()

    const a = new Application()
    await a.listen({ port: 3503, hostname: '127.0.0.1' })

    const b = new Application()
    await b.listen({ port: 3503, hostname: '127.0.0.1' })
    await a.stop(true)
    await b.stop(true)

    expect(signalListenerCounts()).toEqual(before)

    await a.listen({ port: 3503, hostname: '127.0.0.1' })
    expect(signalListenerCounts().sigint).toBe(before.sigint + 2)

    await a.stop(true)
    expect(signalListenerCounts()).toEqual(before)
    expect(activeViteDevServer()).toBeUndefined()
  })

  /**
   * `listen()` with no Vite of its own still retires the managed server it finds,
   * awaiting the close. A record installed concurrently during that wait is a live
   * claim the resuming cleanup must not erase.
   */
  it('preserves a record installed while the restart cleanup was mid-close', async () => {
    seedPreviousViteDevServer(
      {
        close: () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
        httpServer: { listening: false },
      },
      'http://localhost:5175',
    )

    const app = new Application()
    const listening = app.listen({ port: 3504, hostname: '127.0.0.1', vite: false })
    await new Promise((resolve) => setTimeout(resolve, 10))

    // A concurrent listen() elsewhere installed a new record mid-close.
    seedPreviousViteDevServer(
      { close: mock(async () => {}), httpServer: { listening: true } },
      'http://localhost:5199',
    )
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5199'
    process.env.GUREN_MANAGED_VITE_DEV_SERVER = '1'

    await listening

    expect(activeViteDevServer()?.localUrl).toBe('http://localhost:5199')
    expect(process.env.VITE_DEV_SERVER_URL).toBe('http://localhost:5199')

    await app.stop(true)
  })

  /**
   * Two `listen()` calls racing through the fresh-start path each start a Vite dev
   * server; the displaced one has no owner left, so it must be closed, not stranded.
   */
  it('closes the fresh dev server a concurrent listen() displaced', async () => {
    const closeFirst = mock(async () => {})
    const closeSecond = mock(async () => {})
    vite.startViteDevServer
      .mockImplementationOnce(async () => ({
        server: { close: closeFirst, httpServer: { listening: true } },
        localUrl: 'http://localhost:5301',
        networkUrls: [] as string[],
      }))
      .mockImplementationOnce(async () => ({
        server: { close: closeSecond, httpServer: { listening: true } },
        localUrl: 'http://localhost:5302',
        networkUrls: [] as string[],
      }))

    const a = new Application()
    const b = new Application()
    await Promise.all([
      a.listen({ port: 3505, hostname: '127.0.0.1' }),
      b.listen({ port: 3505, hostname: '127.0.0.1' }),
    ])

    // Guard the premise: both calls really started a server of their own.
    expect(vite.startViteDevServer).toHaveBeenCalledTimes(2)

    // Exactly one survives in the slot; the other must have been closed.
    expect(closeFirst.mock.calls.length + closeSecond.mock.calls.length).toBe(1)
    const survivor = activeViteDevServer()?.localUrl
    expect(survivor).toBe(
      closeFirst.mock.calls.length === 1 ? 'http://localhost:5302' : 'http://localhost:5301',
    )

    await a.stop(true)
    await b.stop(true)
  })
})
