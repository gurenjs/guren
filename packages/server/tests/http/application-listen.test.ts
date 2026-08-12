import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import { createViteDevServerMocks, resetGurenGlobals } from './vite-dev-server-fixture'

const vite = createViteDevServerMocks()

await mock.module('../../src/http/vite-dev-server', vite.moduleFactory)

const { Application } = await import('../../src/http/Application')

const originalEnv = { ...process.env }
const originalServe = Bun.serve

beforeEach(() => {
  process.env = { ...originalEnv }
  process.env.NODE_ENV = 'development'
  process.env.GUREN_DEV_BANNER = '0'
  vite.clear()
  // Each test here starts a server that `listen()` records on `globalThis`,
  // and a still-listening record sends the next `listen()` down the hot-reload
  // reuse path instead of the one under test. Bun shares a process across test
  // files, so the leftover can arrive from a sibling file as easily as from
  // the test above — hence a reset on both sides.
  resetGurenGlobals()
})

afterEach(() => {
  process.env = { ...originalEnv }
  Bun.serve = originalServe
  resetGurenGlobals()
})

/**
 * Stubs a bind that succeeds while reporting no `port` and no `hostname`.
 *
 * Both omissions are load-bearing: `listen()` has to fall back to the port it
 * bound and the hostname it was asked for, and a stub written before it read
 * either field must keep working.
 */
function stubBunServe() {
  const serveMock = mock(() => ({ stop: mock(async () => {}) }))
  Bun.serve = serveMock as unknown as typeof Bun.serve
  return serveMock
}

describe('Application.listen', () => {
  it('restarts the managed Vite dev server after a watch reload', async () => {
    const serveMock = stubBunServe()

    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173'
    process.env.GUREN_MANAGED_VITE_DEV_SERVER = '1'
    process.env.GUREN_INERTIA_ENTRY = 'http://localhost:5173/resources/js/dev-entry.ts'

    const app = new Application()
    await app.listen({ port: 3333, hostname: '127.0.0.1' })

    expect(vite.startViteDevServer).toHaveBeenCalledTimes(1)
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

    expect(vite.startViteDevServer).toHaveBeenCalledTimes(1)
    expect(vite.viteClose).toHaveBeenCalled()
    // The discriminating assertions: `listen()` also closes a *previous*
    // server on the way in, so the call count alone proves nothing. These env
    // vars were published by this call's Vite start, and only this call's
    // teardown clears them.
    expect(process.env.VITE_DEV_SERVER_URL).toBeUndefined()
    expect(process.env.GUREN_MANAGED_VITE_DEV_SERVER).toBeUndefined()
  })
})

describe('Application.address', () => {
  it('is undefined before listen()', () => {
    expect(new Application().address).toBeUndefined()
  })

  it('reports the address listen() resolved, not what the live server reports', async () => {
    // Re-deriving the address from the server would lose the port fallback the
    // stub forces here — and `port: 0` has no fallback at all, which is the
    // case the accessor exists for.
    stubBunServe()

    const app = new Application()
    const address = await app.listen({ port: 3333, hostname: '0.0.0.0', vite: false })

    expect(app.address).toEqual(address)
    expect(app.address?.port).toBe(3333)
    // The wildcard bind is mapped once, in listen(), and the accessor hands
    // back that same mapping rather than repeating it.
    expect(app.address?.url).toBe('http://127.0.0.1:3333')
  })

  it('reverts to undefined when a rebind fails after the old server stopped', async () => {
    // `listen()` stops the running server before it tries to bind again, so a
    // failed rebind leaves the app serving nothing. Reporting the old address
    // here would point callers at a socket that is already closed.
    stubBunServe()

    const app = new Application()
    await app.listen({ port: 3333, hostname: '127.0.0.1', vite: false })
    expect(app.address?.port).toBe(3333)

    Bun.serve = mock(() => {
      throw Object.assign(new Error('Failed to start server.'), { code: 'EADDRINUSE' })
    }) as unknown as typeof Bun.serve

    await expect(
      app.listen({ port: 3333, hostname: '127.0.0.1', vite: false, portFallback: false }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' })

    expect(app.address).toBeUndefined()
  })

  it('follows the app to a new address across a restart', async () => {
    stubBunServe()

    const app = new Application()
    await app.listen({ port: 3333, hostname: '127.0.0.1', vite: false })
    await app.listen({ port: 4444, hostname: '127.0.0.1', vite: false })

    expect(app.address?.port).toBe(4444)
    expect(app.address?.url).toBe('http://127.0.0.1:4444')
  })
})
