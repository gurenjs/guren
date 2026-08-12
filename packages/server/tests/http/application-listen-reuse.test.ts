import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import {
  activeViteDevServer,
  createViteDevServerMocks,
  resetGurenGlobals,
  seedPreviousViteDevServer,
} from './vite-dev-server-fixture'

const vite = createViteDevServerMocks()

await mock.module('../../src/http/vite-dev-server', vite.moduleFactory)

const { Application } = await import('../../src/http/Application')

describe('Application.listen Vite dev server reuse on hot reload', () => {
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
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Bun.serve = originalServe
    resetGurenGlobals()
  })

  it('keeps the rest of the vite-dev-server module reachable behind the stub', async () => {
    // Reads what `mock.module` installed, not what the fixture would hand it:
    // this is the one assertion that fails if the module is replaced wholesale
    // rather than spread. Every other test here would pass either way, and the
    // stripped export would surface in whichever file loads it next instead.
    //
    // Load-order dependent, so run it the way CI does. Under `bun run test:bun
    // server` this catches a dropped spread; in a narrower run that loads the
    // module elsewhere first, Bun patches the named export in place and leaves
    // the others reachable, which hides the difference.
    const mocked = await import('../../src/http/vite-dev-server')

    expect(typeof mocked.resolveViteDevServerConfig).toBe('function')
    // Cast because the import is typed as the real module: the stub answers
    // with a stand-in server, not a `ViteDevServer`. Identity is the assertion.
    expect(mocked.startViteDevServer as unknown).toBe(vite.startViteDevServer)
  })

  it('reuses a still-listening managed Vite dev server instead of closing it', async () => {
    // `bun --hot` re-runs the entrypoint but preserves globalThis, so a
    // reload arrives here with the previous run's Vite server still alive.
    // Closing it can hang forever on the browser's open HMR socket — after
    // the Bun server was already stopped — leaving the process without any
    // HTTP listener. Reuse is the fix; this pins it.
    const previousClose = mock(async () => {})
    seedPreviousViteDevServer(
      { close: previousClose, httpServer: { listening: true } },
      'http://localhost:5175',
    )

    Bun.serve = mock(() => ({ stop: mock(async () => {}) })) as unknown as typeof Bun.serve

    const app = new Application()
    await app.listen({ port: 3345, hostname: '127.0.0.1' })

    expect(vite.startViteDevServer).not.toHaveBeenCalled()
    expect(previousClose).not.toHaveBeenCalled()
    expect(process.env.VITE_DEV_SERVER_URL).toBe('http://localhost:5175')
    expect(process.env.GUREN_MANAGED_VITE_DEV_SERVER).toBe('1')
    expect(process.env.GUREN_INERTIA_ENTRY).toBe(
      'http://localhost:5175/resources/js/dev-entry.ts',
    )
    // The reused server stays recorded for the next reload.
    expect(activeViteDevServer()?.localUrl).toBe('http://localhost:5175')
  })

  it('restarts Vite when the previous server is no longer listening', async () => {
    const previousClose = mock(async () => {})
    seedPreviousViteDevServer(
      { close: previousClose, httpServer: { listening: false } },
      'http://localhost:5175',
    )

    Bun.serve = mock(() => ({ stop: mock(async () => {}) })) as unknown as typeof Bun.serve

    const app = new Application()
    await app.listen({ port: 3346, hostname: '127.0.0.1' })

    expect(previousClose).toHaveBeenCalledTimes(1)
    expect(vite.startViteDevServer).toHaveBeenCalledTimes(1)
    expect(process.env.VITE_DEV_SERVER_URL).toBe('http://localhost:5174')
  })

  it('does not reuse when the call passes explicit Vite options', async () => {
    // The running server was built from the previous call's options; explicit
    // options on this call may differ, so they force a restart.
    const previousClose = mock(async () => {})
    seedPreviousViteDevServer(
      { close: previousClose, httpServer: { listening: true } },
      'http://localhost:5175',
    )

    Bun.serve = mock(() => ({ stop: mock(async () => {}) })) as unknown as typeof Bun.serve

    const app = new Application()
    await app.listen({ port: 3347, hostname: '127.0.0.1', vite: { port: 5199 } })

    expect(previousClose).toHaveBeenCalledTimes(1)
    expect(vite.startViteDevServer).toHaveBeenCalledTimes(1)
  })

  it('abandons a previous Vite server whose close() never resolves', async () => {
    // The zombie this guards against: close() hanging after the Bun server
    // was stopped would leave the process alive with no listener at all.
    process.env.GUREN_VITE_CLOSE_TIMEOUT_MS = '50'

    seedPreviousViteDevServer(
      { close: () => new Promise(() => {}), httpServer: { listening: false } },
      'http://localhost:5175',
    )

    Bun.serve = mock(() => ({ stop: mock(async () => {}) })) as unknown as typeof Bun.serve

    const app = new Application()
    await app.listen({ port: 3348, hostname: '127.0.0.1' })

    expect(vite.startViteDevServer).toHaveBeenCalledTimes(1)
    expect(process.env.VITE_DEV_SERVER_URL).toBe('http://localhost:5174')
  })
})
