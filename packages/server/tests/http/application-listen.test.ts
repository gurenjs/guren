import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const viteCloseMock = mock(async () => {})

const startViteDevServerMock = mock(async () => ({
  server: {
    close: viteCloseMock,
  },
  localUrl: 'http://localhost:5174',
  networkUrls: [],
}))

await mock.module('../../src/http/vite-dev-server', () => ({
  startViteDevServer: startViteDevServerMock,
}))

const { Application } = await import('../../src/http/Application')

describe('Application.listen', () => {
  const originalEnv = { ...process.env }
  const originalServe = Bun.serve

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.NODE_ENV = 'development'
    process.env.GUREN_DEV_BANNER = '0'
    startViteDevServerMock.mockClear()
    viteCloseMock.mockClear()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Bun.serve = originalServe
  })

  it('restarts the managed Vite dev server after a watch reload', async () => {
    // Deliberately reports no `port`: a stub that predates the bound-address
    // return must keep working, so listen() falls back to the port it bound.
    const serveMock = mock(() => ({ stop: mock(async () => {}) }))
    Bun.serve = serveMock as unknown as typeof Bun.serve

    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173'
    process.env.GUREN_MANAGED_VITE_DEV_SERVER = '1'
    process.env.GUREN_INERTIA_ENTRY = 'http://localhost:5173/resources/js/dev-entry.ts'

    const app = new Application()
    await app.listen({ port: 3333, hostname: '127.0.0.1' })

    expect(startViteDevServerMock).toHaveBeenCalledTimes(1)
    expect(process.env.VITE_DEV_SERVER_URL).toBe('http://localhost:5174')
    expect(process.env.GUREN_MANAGED_VITE_DEV_SERVER).toBe('1')
    expect(process.env.GUREN_INERTIA_ENTRY).toBe('http://localhost:5174/resources/js/dev-entry.ts')
    expect(serveMock).toHaveBeenCalledTimes(1)
  })

  it('shuts the managed Vite dev server down when the bind fails', async () => {
    // Vite is started before anything tries to bind, so a bind that throws
    // past it would strand an asset server and its published env vars in a
    // process with no application server. `GUREN_STRICT_PORT=1` makes that the
    // expected path for automated callers, which handle the rejection rather
    // than exiting.
    const addressInUse = Object.assign(new Error('Failed to start server.'), {
      code: 'EADDRINUSE',
    })
    Bun.serve = mock(() => {
      throw addressInUse
    }) as unknown as typeof Bun.serve

    process.env.GUREN_STRICT_PORT = '1'

    const app = new Application()
    await expect(app.listen({ port: 3333, hostname: '127.0.0.1' })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    })

    expect(startViteDevServerMock).toHaveBeenCalledTimes(1)
    expect(viteCloseMock).toHaveBeenCalled()
    // The discriminating assertions: `listen()` also closes a *previous*
    // server on the way in, so the call count alone proves nothing. These env
    // vars were published by this call's Vite start, and only this call's
    // teardown clears them.
    expect(process.env.VITE_DEV_SERVER_URL).toBeUndefined()
    expect(process.env.GUREN_MANAGED_VITE_DEV_SERVER).toBeUndefined()
  })
})
