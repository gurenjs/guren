import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import { Application } from '../../src/http/Application'
import { gurenGlobals, resetGurenGlobals } from './vite-dev-server-fixture'

/**
 * `listen()` and `stop()` interleaving.
 *
 * Both await a server `stop()` before they touch the fields that record which
 * server this process is running, so either can resume to find the state it
 * remembered replaced by a live server. What must never happen is that the
 * resuming call clears the *newer* server's bookkeeping: a socket with no
 * instance handle and no signal handlers is bound for the rest of the process
 * lifetime, and nothing left can close it.
 *
 * `Bun.serve` is stubbed throughout — these cases are about which references
 * survive, and a stub reports that far more precisely than a real socket. The
 * sibling `application-stop.test.ts` binds real ones.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface StubServer {
  readonly id: string
  readonly port: number
  readonly hostname: string
  stop: (closeActiveConnections?: boolean) => Promise<void>
}

describe('Application.listen and Application.stop interleaving', () => {
  const originalEnv = { ...process.env }
  const originalServe = Bun.serve

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.NODE_ENV = 'development'
    process.env.GUREN_DEV_BANNER = '0'
    resetGurenGlobals()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Bun.serve = originalServe
    resetGurenGlobals()
  })

  /**
   * The graceful/forced asymmetry is Bun's own: `stop(false)` waits for
   * in-flight requests, `stop(true)` does not. It is what lets `listen()`'s
   * forced stop run to completion inside the window a graceful `stop()` is
   * still waiting in.
   */
  it('leaves the new server owned when a listen() lands inside a graceful stop()', async () => {
    const stops: Array<{ id: string; force: unknown }> = []
    const servers: StubServer[] = ['S1', 'S2'].map((id) => ({
      id,
      port: 3600,
      hostname: '127.0.0.1',
      stop: async (closeActiveConnections?: boolean) => {
        stops.push({ id, force: closeActiveConnections })
        if (!closeActiveConnections) await sleep(100)
      },
    }))

    let next = 0
    Bun.serve = mock(() => servers[next++]) as unknown as typeof Bun.serve

    const app = new Application()
    await app.listen({ port: 3600, hostname: '127.0.0.1', vite: false })
    const listeningHandlers = process.listenerCount('SIGINT')

    const stopping = app.stop()
    await sleep(5)
    await app.listen({ port: 3600, hostname: '127.0.0.1', vite: false })
    await stopping

    // Guard the premise: the stop() really did resume after the rebind.
    expect(stops.map((entry) => entry.id)).toEqual(['S1', 'S1'])
    expect(next).toBe(2)

    // S2 is bound and was never stopped, so the app must still hold it.
    expect(app.address).toBeDefined()
    expect(gurenGlobals.__gurenActiveServer).toBe(servers[1])
    expect(process.listenerCount('SIGINT')).toBe(listeningHandlers)

    await app.stop(true)
    expect(stops.some((entry) => entry.id === 'S2')).toBe(true)
  })

  /**
   * The same hazard between two applications. `listen()`'s force-stop of the
   * previous server used to clear the process-wide slot unconditionally once it
   * finished — including when a `listen()` elsewhere had already repointed that
   * slot at a server of its own.
   *
   * The `listen()` doing the stale cleanup then fails to bind, which is what
   * makes the damage stick: it never sets a server of its own into the slot it
   * just wiped. The slot is what the SIGINT/SIGTERM/exit teardown reads, so a
   * wiped slot means the surviving app's socket is never closed at shutdown —
   * and `address` reports nothing is listening while it is.
   */
  it('keeps the active-server slot when a stale cleanup finishes late', async () => {
    process.env.GUREN_STRICT_PORT = '1'

    const stopped: string[] = []
    const makeServer = (id: string, firstStopDelay: number): StubServer => {
      let calls = 0
      return {
        id,
        port: 3601,
        hostname: '127.0.0.1',
        stop: async () => {
          stopped.push(id)
          // Only the first stop waits: a second stop of an already-stopping
          // server has nothing left to drain.
          if (calls++ === 0) await sleep(firstStopDelay)
        },
      }
    }

    const servers = [makeServer('S1', 60), makeServer('S2', 0)]
    let next = 0
    Bun.serve = mock(() => {
      const server = servers[next++]
      if (!server) {
        throw Object.assign(new Error('address already in use'), { code: 'EADDRINUSE' })
      }
      return server
    }) as unknown as typeof Bun.serve

    const a = new Application()
    await a.listen({ port: 3601, hostname: '127.0.0.1', vite: false })

    // B is still awaiting S1's slow stop when C stops it again (fast), binds
    // S2, and takes the slot. B then resumes, and its own bind fails.
    const b = new Application()
    const bListening = b.listen({ port: 3601, hostname: '127.0.0.1', vite: false })
    await sleep(5)
    const c = new Application()
    await c.listen({ port: 3601, hostname: '127.0.0.1', vite: false })

    expect(gurenGlobals.__gurenActiveServer).toBe(servers[1])

    await expect(bListening).rejects.toThrow(/address already in use/u)

    // Guard the premise: B really was mid-cleanup, and C's server was never
    // stopped — so nothing legitimately displaced it.
    expect(stopped).toEqual(['S1', 'S1'])

    expect(gurenGlobals.__gurenActiveServer).toBe(servers[1])
    expect(c.address).toBeDefined()

    await a.stop(true)
    await c.stop(true)
  })

  /**
   * Two `listen()` calls racing on one instance: the empty active slot gives
   * each call's entry force-stop nothing to wait on, so both bind, and the
   * later assignment used to overwrite the instance handle — leaving the
   * earlier socket live with nothing holding it. The displaced server has to
   * be stopped, not dropped.
   */
  it('stops the server a concurrent listen() on the same instance displaced', async () => {
    const stopped: string[] = []
    const makeServer = (id: string): StubServer => ({
      id,
      port: 3603,
      hostname: '127.0.0.1',
      stop: async () => {
        stopped.push(id)
      },
    })
    const servers = [makeServer('S1'), makeServer('S2')]
    let next = 0
    Bun.serve = mock(() => servers[next++]) as unknown as typeof Bun.serve

    const app = new Application()
    await Promise.all([
      app.listen({ port: 3603, hostname: '127.0.0.1', vite: false }),
      app.listen({ port: 3603, hostname: '127.0.0.1', vite: false }),
    ])

    // Guard the premise: both calls really bound a server.
    expect(next).toBe(2)

    // One server keeps the instance handle; the other must have been stopped.
    expect(stopped.length).toBe(1)
    expect(app.address).toBeDefined()

    await app.stop(true)
    expect(new Set(stopped).size).toBe(2)
  })

  /**
   * A `stop` that throws synchronously must be contained like one that
   * rejects: letting it escape would leave `stop()` rejected with the
   * instance fields still set and the signal handlers still attached.
   */
  it('survives a stop() that throws synchronously, and still releases the app', async () => {
    const server = {
      port: 3604,
      hostname: '127.0.0.1',
      stop: () => {
        throw new Error('boom')
      },
    }
    Bun.serve = mock(() => server) as unknown as typeof Bun.serve

    const app = new Application()
    await app.listen({ port: 3604, hostname: '127.0.0.1', vite: false })
    const listening = process.listenerCount('SIGINT')

    await app.stop()

    expect(app.address).toBeUndefined()
    expect(gurenGlobals.__gurenActiveServer).toBeUndefined()
    expect(process.listenerCount('SIGINT')).toBe(listening - 1)
  })

  /**
   * A graceful stop waits on in-flight requests, and a request that never
   * completes would hold the wait open forever. The bound is the same shape as
   * the Vite close bound, and abandoning it is safer here: the socket has
   * already stopped accepting connections, so what is left is a drain.
   */
  it('gives up on a stop() that never resolves, and still releases the app', async () => {
    process.env.GUREN_BUN_STOP_TIMEOUT_MS = '50'

    const server = {
      port: 3602,
      hostname: '127.0.0.1',
      stop: () => new Promise<void>(() => {}),
    }
    Bun.serve = mock(() => server) as unknown as typeof Bun.serve

    const app = new Application()
    await app.listen({ port: 3602, hostname: '127.0.0.1', vite: false })
    const listeningHandlers = process.listenerCount('SIGINT')

    await app.stop()

    expect(app.address).toBeUndefined()
    expect(gurenGlobals.__gurenActiveServer).toBeUndefined()
    expect(process.listenerCount('SIGINT')).toBe(listeningHandlers - 1)
  })
})
