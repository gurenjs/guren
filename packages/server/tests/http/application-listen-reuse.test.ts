import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const viteCloseMock = mock(async () => {})

const startViteDevServerMock = mock(async () => ({
  server: {
    close: viteCloseMock,
    httpServer: { listening: true },
  },
  localUrl: 'http://localhost:5174',
  networkUrls: [],
}))

await mock.module('../../src/http/vite-dev-server', () => ({
  startViteDevServer: startViteDevServerMock,
}))

const { Application } = await import('../../src/http/Application')

type GurenGlobal = typeof globalThis & {
  __gurenActiveServer?: unknown
  __gurenActiveViteDevServer?: unknown
  __gurenActiveViteDevServerUrl?: string
}

const globalState = globalThis as GurenGlobal

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
    startViteDevServerMock.mockClear()
    viteCloseMock.mockClear()
    globalState.__gurenActiveServer = undefined
    globalState.__gurenActiveViteDevServer = undefined
    globalState.__gurenActiveViteDevServerUrl = undefined
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Bun.serve = originalServe
    globalState.__gurenActiveServer = undefined
    globalState.__gurenActiveViteDevServer = undefined
    globalState.__gurenActiveViteDevServerUrl = undefined
  })

  it('reuses a still-listening managed Vite dev server instead of closing it', async () => {
    // `bun --hot` re-runs the entrypoint but preserves globalThis, so a
    // reload arrives here with the previous run's Vite server still alive.
    // Closing it can hang forever on the browser's open HMR socket — after
    // the Bun server was already stopped — leaving the process without any
    // HTTP listener. Reuse is the fix; this pins it.
    const previousClose = mock(async () => {})
    globalState.__gurenActiveViteDevServer = {
      close: previousClose,
      httpServer: { listening: true },
    }
    globalState.__gurenActiveViteDevServerUrl = 'http://localhost:5175'

    Bun.serve = mock(() => ({ stop: mock(async () => {}) })) as unknown as typeof Bun.serve

    const app = new Application()
    await app.listen({ port: 3345, hostname: '127.0.0.1' })

    expect(startViteDevServerMock).not.toHaveBeenCalled()
    expect(previousClose).not.toHaveBeenCalled()
    expect(process.env.VITE_DEV_SERVER_URL).toBe('http://localhost:5175')
    expect(process.env.GUREN_MANAGED_VITE_DEV_SERVER).toBe('1')
    expect(process.env.GUREN_INERTIA_ENTRY).toBe(
      'http://localhost:5175/resources/js/dev-entry.ts',
    )
    // The reused server stays recorded for the next reload.
    expect(globalState.__gurenActiveViteDevServerUrl).toBe('http://localhost:5175')
  })

  it('restarts Vite when the previous server is no longer listening', async () => {
    const previousClose = mock(async () => {})
    globalState.__gurenActiveViteDevServer = {
      close: previousClose,
      httpServer: { listening: false },
    }
    globalState.__gurenActiveViteDevServerUrl = 'http://localhost:5175'

    Bun.serve = mock(() => ({ stop: mock(async () => {}) })) as unknown as typeof Bun.serve

    const app = new Application()
    await app.listen({ port: 3346, hostname: '127.0.0.1' })

    expect(previousClose).toHaveBeenCalledTimes(1)
    expect(startViteDevServerMock).toHaveBeenCalledTimes(1)
    expect(process.env.VITE_DEV_SERVER_URL).toBe('http://localhost:5174')
  })

  it('does not reuse when the call passes explicit Vite options', async () => {
    // The running server was built from the previous call's options; explicit
    // options on this call may differ, so they force a restart.
    const previousClose = mock(async () => {})
    globalState.__gurenActiveViteDevServer = {
      close: previousClose,
      httpServer: { listening: true },
    }
    globalState.__gurenActiveViteDevServerUrl = 'http://localhost:5175'

    Bun.serve = mock(() => ({ stop: mock(async () => {}) })) as unknown as typeof Bun.serve

    const app = new Application()
    await app.listen({ port: 3347, hostname: '127.0.0.1', vite: { port: 5199 } })

    expect(previousClose).toHaveBeenCalledTimes(1)
    expect(startViteDevServerMock).toHaveBeenCalledTimes(1)
  })

  it('abandons a previous Vite server whose close() never resolves', async () => {
    // The zombie this guards against: close() hanging after the Bun server
    // was stopped would leave the process alive with no listener at all.
    process.env.GUREN_VITE_CLOSE_TIMEOUT_MS = '50'

    globalState.__gurenActiveViteDevServer = {
      close: () => new Promise(() => {}),
      httpServer: { listening: false },
    }
    globalState.__gurenActiveViteDevServerUrl = 'http://localhost:5175'

    Bun.serve = mock(() => ({ stop: mock(async () => {}) })) as unknown as typeof Bun.serve

    const app = new Application()
    await app.listen({ port: 3348, hostname: '127.0.0.1' })

    expect(startViteDevServerMock).toHaveBeenCalledTimes(1)
    expect(process.env.VITE_DEV_SERVER_URL).toBe('http://localhost:5174')
  })
})
