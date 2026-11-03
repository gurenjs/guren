import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { createViteDevServerMocks, resetGurenGlobals } from './vite-dev-server-fixture'

const vite = createViteDevServerMocks()

await mock.module('../../src/http/vite-dev-server', vite.moduleFactory)

const { Application } = await import('../../src/http/Application')
type StartViteDevServerOptions = import('../../src/http/vite-dev-server').StartViteDevServerOptions

const originalEnv = { ...process.env }
const originalServe = Bun.serve

beforeEach(() => {
  process.env = { ...originalEnv }
  process.env.NODE_ENV = 'development'
  process.env.GUREN_DEV_BANNER = '0'
  // Developers set it to keep parallel sessions apart; carried in, it would decide the ports asserted below.
  delete process.env.GUREN_VITE_PORT
  vite.clear()
  // A still-listening record on `globalThis` sends the next `listen()` down the
  // hot-reload reuse path instead of the one under test, and Bun shares a process
  // across test files — hence a reset on both sides.
  resetGurenGlobals()
})

afterEach(() => {
  process.env = { ...originalEnv }
  Bun.serve = originalServe
  resetGurenGlobals()
})

/**
 * Stubs a bind that succeeds while reporting no `port` and no `hostname`, so
 * `listen()` must fall back to the port it bound and the hostname it was asked for.
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
    // Vite starts before the bind, so a throwing bind would strand an asset server
    // and its published env vars in a process with no application server.
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
    // `listen()` also closes a *previous* server on the way in, so the call count
    // proves nothing; only this call's teardown clears these env vars.
    expect(process.env.VITE_DEV_SERVER_URL).toBeUndefined()
    expect(process.env.GUREN_MANAGED_VITE_DEV_SERVER).toBeUndefined()
  })
})

describe('Application.listen Vite port', () => {
  /** The options the managed start was handed, read back from the mock. */
  function startOptions(): StartViteDevServerOptions | undefined {
    return (vite.startViteDevServer.mock.calls[0] as unknown[] | undefined)?.[0] as StartViteDevServerOptions | undefined
  }

  it('starts Vite on GUREN_VITE_PORT', async () => {
    stubBunServe()
    process.env.GUREN_VITE_PORT = '5188'

    await new Application().listen({ port: 3333, hostname: '127.0.0.1' })

    expect(startOptions()?.port).toBe(5188)
  })

  it("leaves the port to the project's Vite config when GUREN_VITE_PORT is unset or blank", async () => {
    // An inline 5173 would override a `server.port` the app's vite.config.ts sets.
    stubBunServe()
    await new Application().listen({ port: 3333, hostname: '127.0.0.1' })
    expect(startOptions()).toBeDefined()
    expect(startOptions()?.port).toBeUndefined()

    vite.clear()
    resetGurenGlobals()
    process.env.GUREN_VITE_PORT = '  '
    await new Application().listen({ port: 3333, hostname: '127.0.0.1' })
    expect(startOptions()).toBeDefined()
    expect(startOptions()?.port).toBeUndefined()
  })

  it('lets an explicit vite.port win over GUREN_VITE_PORT', async () => {
    stubBunServe()
    process.env.GUREN_VITE_PORT = '5188'

    await new Application().listen({ port: 3333, hostname: '127.0.0.1', vite: { port: 6100 } })

    expect(startOptions()?.port).toBe(6100)
  })

  it('fails before starting Vite or binding when GUREN_VITE_PORT is not a port', async () => {
    const serveMock = stubBunServe()
    process.env.GUREN_VITE_PORT = '51 73'

    await expect(new Application().listen({ port: 3333, hostname: '127.0.0.1' })).rejects.toThrow(
      'Failed to start Vite dev server: GUREN_VITE_PORT must be a port number from 0 to 65535, got "51 73".',
    )

    expect(vite.startViteDevServer).not.toHaveBeenCalled()
    expect(serveMock).not.toHaveBeenCalled()
  })

  it('names the port Vite bound in the banner and the published URL, not the one asked for', async () => {
    // The stub reports binding 5174, as Vite does after walking past a busy 5188.
    stubBunServe()
    process.env.GUREN_VITE_PORT = '5188'
    delete process.env.GUREN_DEV_BANNER
    const log = spyOn(console, 'log').mockImplementation(() => {})
    let banner = ''
    try {
      await new Application().listen({ port: 3333, hostname: '127.0.0.1' })
      banner = log.mock.calls.flat().join('\n')
    } finally {
      log.mockRestore()
    }

    expect(banner).toContain('http://localhost:5174 (Vite, started by Guren)')
    expect(banner).not.toContain('5188')
    expect(process.env.VITE_DEV_SERVER_URL).toBe('http://localhost:5174')
    expect(process.env.GUREN_INERTIA_ENTRY).toBe('http://localhost:5174/resources/js/dev-entry.ts')
  })
})

describe('Application.listen startup line', () => {
  it('prints the bound address once in production, where the banner is off', async () => {
    stubBunServe()
    process.env.NODE_ENV = 'production'
    delete process.env.GUREN_DEV_BANNER
    const info = spyOn(console, 'info').mockImplementation(() => {})
    try {
      await new Application().listen({ port: 3333, hostname: '0.0.0.0', vite: false })

      expect(info).toHaveBeenCalledTimes(1)
      expect(info).toHaveBeenCalledWith('[guren] Listening on http://0.0.0.0:3333')
    } finally {
      info.mockRestore()
    }
  })

  it('prints nothing outside production when the banner is turned off', async () => {
    stubBunServe()
    const info = spyOn(console, 'info').mockImplementation(() => {})
    try {
      await new Application().listen({ port: 3333, hostname: '127.0.0.1', vite: false })

      expect(info).not.toHaveBeenCalled()
    } finally {
      info.mockRestore()
    }
  })
})

describe('Application.listen dev banner asset server', () => {
  async function bannerOf(start: () => Promise<unknown>): Promise<string> {
    delete process.env.GUREN_DEV_BANNER
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await start()
      return log.mock.calls.flat().join('\n')
    } finally {
      log.mockRestore()
    }
  }

  it('says Guren started the Vite dev server it launched', async () => {
    stubBunServe()
    delete process.env.VITE_DEV_SERVER_URL
    delete process.env.GUREN_DEV_VITE

    const banner = await bannerOf(() => new Application().listen({ port: 3333, hostname: '127.0.0.1' }))

    expect(vite.startViteDevServer).toHaveBeenCalledTimes(1)
    expect(banner).toContain('http://localhost:5174 (Vite, started by Guren)')
  })

  it('says an asset server named by VITE_DEV_SERVER_URL is not one Guren started', async () => {
    stubBunServe()
    delete process.env.GUREN_MANAGED_VITE_DEV_SERVER
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:4241'

    const banner = await bannerOf(() => new Application().listen({ port: 3333, hostname: '127.0.0.1' }))

    expect(vite.startViteDevServer).not.toHaveBeenCalled()
    expect(banner).toContain('http://localhost:4241 (not started by Guren, run it yourself)')
  })

  it('says so when Vite is turned off and no asset server is named', async () => {
    stubBunServe()
    delete process.env.VITE_DEV_SERVER_URL

    const banner = await bannerOf(() => new Application().listen({ port: 3333, hostname: '127.0.0.1', vite: false }))

    expect(vite.startViteDevServer).not.toHaveBeenCalled()
    expect(banner).toContain('(not started by Guren, run it yourself)')
  })
})

describe('Application.address', () => {
  it('is undefined before listen()', () => {
    expect(new Application().address).toBeUndefined()
  })

  it('reports the address listen() resolved, not what the live server reports', async () => {
    // Re-deriving the address from the server would lose the port fallback the
    // stub forces here, and `port: 0` has no fallback at all.
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
    // `listen()` stops the running server before rebinding, so reporting the old
    // address after a failed rebind would point callers at a closed socket.
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
