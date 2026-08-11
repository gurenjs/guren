import { afterEach, describe, expect, it } from 'bun:test'

import { Application } from '../../src/http/Application'

/**
 * These tests bind real sockets rather than stubbing `Bun.serve`.
 *
 * The behaviour under test *is* what happens when a port is genuinely taken —
 * a stub that throws a hand-made `EADDRINUSE` would pin the framework's
 * reaction to its own fixture, not to the runtime. Everything here is on
 * 127.0.0.1 and closed in `afterEach`.
 */

type StoppableServer = { stop?: (closeConnections?: boolean) => void | Promise<void> }

const openServers: StoppableServer[] = []

function occupyPort(): number {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('occupied'),
  })
  openServers.push(server)
  if (typeof server.port !== 'number') {
    throw new Error('Bun.serve did not report a port for the occupying server')
  }
  return server.port
}

function occupyExactPort(port: number): StoppableServer {
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: () => new Response('occupied'),
  })
  openServers.push(server)
  return server
}

async function stopServer(server: StoppableServer | undefined): Promise<void> {
  await server?.stop?.(true)
}

/**
 * A base port with `length` consecutive free ports after it.
 *
 * Binding the whole run up front and releasing it is the only way to know the
 * run is free; probing one port at a time would race with whatever else on the
 * machine is handing out ephemeral ports.
 */
function findFreeRun(length: number): number | undefined {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const base = occupyPort()
    const held: StoppableServer[] = []

    try {
      for (let offset = 1; offset < length; offset += 1) {
        held.push(
          Bun.serve({ port: base + offset, hostname: '127.0.0.1', fetch: () => new Response('') }),
        )
      }
    } catch {
      held.forEach((server) => server.stop?.(true))
      continue
    }

    held.forEach((server) => server.stop?.(true))
    // `base` itself stays held by `openServers` so nothing reclaims it.
    return base
  }

  return undefined
}

async function listen(
  app: Application,
  options: Parameters<Application['listen']>[0],
): Promise<Awaited<ReturnType<Application['listen']>>> {
  const address = await app.listen(options)
  const server = (app as unknown as { bunServer?: StoppableServer }).bunServer
  if (server) {
    openServers.push(server)
  }
  return address
}

// Assertions below match on `code`, not the message: Bun's message is
// "Failed to start server. Is port N in use?" and never says EADDRINUSE, and
// `code` is what the framework's own `isAddressInUse()` reads.
const ADDRESS_IN_USE = { code: 'EADDRINUSE' }

afterEach(async () => {
  delete process.env.GUREN_STRICT_PORT
  while (openServers.length > 0) {
    const server = openServers.pop()
    await server?.stop?.(true)
  }
})

describe('Application.listen port binding', () => {
  it('reports the port it actually bound, not the one that was requested', async () => {
    const app = new Application()
    const requested = occupyPort()

    const address = await listen(app, {
      port: requested,
      hostname: '127.0.0.1',
      vite: false,
      portFallback: true,
    })

    expect(address.port).not.toBe(requested)
    expect(address.port).toBeGreaterThan(requested)
    expect(address.port).toBeLessThanOrEqual(requested + 20)
    expect(address.url).toBe(`http://127.0.0.1:${address.port}`)

    // The returned address is the one that answers — the whole point of
    // returning it is that a caller can use it without guessing.
    const response = await fetch(`${address.url}/__does-not-exist`)
    expect(response.status).toBe(404)
  })

  it('gives up after exactly 20 ports, matching the scaffolded loop', async () => {
    // The `<= requested + 20` assertion above cannot tell 20 attempts from 21.
    // The boundary needs its own case: a scaffolded app and the framework must
    // give up on the same port, or the two disagree about when a range is
    // exhausted — and the scaffolded loop is the behaviour being preserved.
    const base = findFreeRun(20)
    if (base === undefined) {
      throw new Error('No run of 20 consecutive free ports available to test the boundary')
    }

    // `findFreeRun` already holds `base`; add base+1 .. base+18 so 19 of the
    // 20 attempts are busy and base+19 is the 20th and final one.
    for (let offset = 1; offset <= 18; offset += 1) {
      occupyExactPort(base + offset)
    }

    const address = await listen(new Application(), {
      port: base,
      hostname: '127.0.0.1',
      vite: false,
      portFallback: true,
    })
    expect(address.port).toBe(base + 19)

    // Hand base+19 to a blocker too: all 20 attempts are now busy, and the
    // walk must run out rather than reach base + 20.
    await stopServer(openServers.pop())
    occupyExactPort(base + 19)

    await expect(
      listen(new Application(), {
        port: base,
        hostname: '127.0.0.1',
        vite: false,
        portFallback: true,
      }),
    ).rejects.toMatchObject(ADDRESS_IN_USE)
  })

  it('resolves an OS-assigned port when asked for port 0', async () => {
    const app = new Application()

    const address = await listen(app, { port: 0, hostname: '127.0.0.1', vite: false })

    expect(address.port).toBeGreaterThan(0)
    const response = await fetch(`${address.url}/__does-not-exist`)
    expect(response.status).toBe(404)
  })

  it('fails fast with EADDRINUSE when GUREN_STRICT_PORT=1', async () => {
    const app = new Application()
    const requested = occupyPort()
    process.env.GUREN_STRICT_PORT = '1'

    const attempt = listen(app, {
      port: requested,
      hostname: '127.0.0.1',
      vite: false,
      // Even an explicit opt-in to the walk loses to the strict flag: an
      // automated consumer pins the port from the outside, without editing
      // the app's entrypoint.
      portFallback: true,
    })

    await expect(attempt).rejects.toMatchObject(ADDRESS_IN_USE)
  })

  it('fails fast with EADDRINUSE when the walk is disabled', async () => {
    const app = new Application()
    const requested = occupyPort()

    const attempt = listen(app, {
      port: requested,
      hostname: '127.0.0.1',
      vite: false,
      portFallback: false,
    })

    await expect(attempt).rejects.toMatchObject(ADDRESS_IN_USE)
  })

  it('logs the bound port in the dev banner after a walk', async () => {
    const app = new Application()
    const requested = occupyPort()

    const originalLog = console.log
    const originalWarn = console.warn
    const logs: string[] = []
    const warnings: string[] = []
    console.log = (...args: unknown[]) => {
      logs.push(args.join(' '))
    }
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '))
    }

    const originalNodeEnv = process.env.NODE_ENV
    try {
      delete process.env.GUREN_DEV_BANNER
      // The banner is suppressed in production, so an inherited
      // NODE_ENV=production would fail this on correct behaviour.
      process.env.NODE_ENV = 'development'
      const address = await listen(app, {
        port: requested,
        hostname: '127.0.0.1',
        vite: false,
        portFallback: true,
      })

      const banner = logs.join('\n')
      expect(banner).toContain(String(address.port))
      // The requested port is busy; printing it would send the developer to
      // somebody else's server.
      expect(banner).not.toContain(String(requested))
      expect(warnings.join('\n')).toContain(`Port ${requested} is in use`)
    } finally {
      console.log = originalLog
      console.warn = originalWarn
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }
    }
  })
})
