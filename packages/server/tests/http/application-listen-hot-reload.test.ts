import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { Application } from '../../src/http/Application'
import { withHotRuntime } from '../../src/hot-reload/testing'
import { gurenGlobals, resetGurenGlobals } from './vite-dev-server-fixture'

/**
 * A `bun --hot` reload calls `listen()` again in the same process and force-stops
 * the server the previous evaluation bound. On Bun 1.3.x that `stop()` never
 * resolves once the server itself closed a WebSocket, which the broadcast
 * manager's hot-reload teardown does to every live socket, so the reload is
 * bounded at 250 ms there. `Bun.serve` is stubbed with a stop that never resolves.
 */
interface StubServer {
  readonly port: number
  readonly hostname: string
  readonly stops: unknown[]
  stop: (closeActiveConnections?: boolean) => Promise<void>
}

function neverStopping(): StubServer {
  const stops: unknown[] = []
  return {
    port: 3610,
    hostname: '127.0.0.1',
    stops,
    stop: (closeActiveConnections?: boolean) => {
      stops.push(closeActiveConnections)
      return new Promise<void>(() => {})
    },
  }
}

describe('Application.listen under bun --hot', () => {
  const originalEnv = { ...process.env }
  const originalServe = Bun.serve
  let warn: ReturnType<typeof spyOn>
  let apps: Application[]

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.NODE_ENV = 'development'
    process.env.GUREN_DEV_BANNER = '0'
    delete process.env.GUREN_BUN_STOP_TIMEOUT_MS
    resetGurenGlobals()
    apps = []
    warn = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    // Releases each app's signal handlers; the stubs never resolve, so bound it.
    process.env.GUREN_BUN_STOP_TIMEOUT_MS = '20'
    for (const app of apps) await app.stop(true)
    warn.mockRestore()
    process.env = { ...originalEnv }
    Bun.serve = originalServe
    resetGurenGlobals()
  })

  function listen(): Promise<Application> {
    const app = new Application()
    apps.push(app)
    return app.listen({ port: 3610, hostname: '127.0.0.1', vite: false }).then(() => app)
  }

  it('force-stops the replaced server and gives it up at the short bound, without warning', async () => {
    const servers = [neverStopping(), neverStopping()]
    let next = 0
    Bun.serve = mock(() => servers[next++]) as unknown as typeof Bun.serve

    await withHotRuntime(async () => {
      await listen()

      const started = performance.now()
      await listen()
      const elapsed = performance.now() - started

      // The bound is 250 ms: under 200 would mean the stop was skipped, and
      // 2 s is the widest a slow CI runner may stretch it while still telling
      // it apart from the 5 s default.
      expect(servers[0].stops).toEqual([true])
      expect(elapsed).toBeGreaterThanOrEqual(200)
      expect(elapsed).toBeLessThan(2000)
      expect(gurenGlobals.__gurenActiveServer).toBe(servers[1])
      expect(warn).not.toHaveBeenCalled()
    })
  })

  it('lets GUREN_BUN_STOP_TIMEOUT_MS shorten the bound but not lengthen it', async () => {
    process.env.GUREN_BUN_STOP_TIMEOUT_MS = '30000'
    const servers = [neverStopping(), neverStopping(), neverStopping()]
    let next = 0
    Bun.serve = mock(() => servers[next++]) as unknown as typeof Bun.serve

    await withHotRuntime(async () => {
      await listen()
      let started = performance.now()
      await listen()
      expect(performance.now() - started).toBeLessThan(2000)

      process.env.GUREN_BUN_STOP_TIMEOUT_MS = '20'
      started = performance.now()
      await listen()
      expect(performance.now() - started).toBeLessThan(200)
      expect(servers[1].stops).toEqual([true])
      expect(warn).not.toHaveBeenCalled()
    })
  })

  it('keeps the default bound and its warning for a listen() outside --hot', async () => {
    process.env.GUREN_BUN_STOP_TIMEOUT_MS = '50'
    const servers = [neverStopping(), neverStopping()]
    let next = 0
    Bun.serve = mock(() => servers[next++]) as unknown as typeof Bun.serve

    await listen()
    await listen()

    expect(servers[0].stops).toEqual([true])
    expect(gurenGlobals.__gurenActiveServer).toBe(servers[1])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('did not stop within 50ms')
  })
})
