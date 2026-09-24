import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { Application } from '../../src/http/Application'
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
  stop: (closeActiveConnections?: boolean) => Promise<void>
}

function neverStopping(): StubServer {
  return { port: 3610, hostname: '127.0.0.1', stop: () => new Promise<void>(() => {}) }
}

async function withHotRuntime<T>(callback: () => Promise<T>): Promise<T> {
  process.execArgv.push('--hot')
  try {
    return await callback()
  } finally {
    process.execArgv.splice(process.execArgv.indexOf('--hot'), 1)
  }
}

describe('Application.listen under bun --hot', () => {
  const originalEnv = { ...process.env }
  const originalServe = Bun.serve
  let warn: ReturnType<typeof spyOn>

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.NODE_ENV = 'development'
    process.env.GUREN_DEV_BANNER = '0'
    delete process.env.GUREN_BUN_STOP_TIMEOUT_MS
    resetGurenGlobals()
    warn = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    process.env = { ...originalEnv }
    Bun.serve = originalServe
    resetGurenGlobals()
  })

  it('gives up on the replaced server well inside the default bound, without warning', async () => {
    const servers = [neverStopping(), neverStopping()]
    let next = 0
    Bun.serve = mock(() => servers[next++]) as unknown as typeof Bun.serve

    await withHotRuntime(async () => {
      const first = new Application()
      await first.listen({ port: 3610, hostname: '127.0.0.1', vite: false })

      const started = performance.now()
      const second = new Application()
      await second.listen({ port: 3610, hostname: '127.0.0.1', vite: false })
      const elapsed = performance.now() - started

      // 250 ms is the bound; 2 s is the widest a slow CI runner may stretch it
      // while still telling it apart from the 5 s default.
      expect(elapsed).toBeLessThan(2000)
      expect(gurenGlobals.__gurenActiveServer).toBe(servers[1])
      expect(warn).not.toHaveBeenCalled()
    })
  })

  it('keeps the default bound and its warning for a listen() outside --hot', async () => {
    process.env.GUREN_BUN_STOP_TIMEOUT_MS = '50'
    const servers = [neverStopping(), neverStopping()]
    let next = 0
    Bun.serve = mock(() => servers[next++]) as unknown as typeof Bun.serve

    const first = new Application()
    await first.listen({ port: 3610, hostname: '127.0.0.1', vite: false })
    const second = new Application()
    await second.listen({ port: 3610, hostname: '127.0.0.1', vite: false })

    expect(gurenGlobals.__gurenActiveServer).toBe(servers[1])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('did not stop within 50ms')
  })
})
