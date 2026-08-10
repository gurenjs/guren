import { describe, test, expect, afterEach } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import {
  createMcpAccessGuard,
  isLoopbackAddress,
  isLoopbackOrigin,
  isMcpEndpointEnabled,
  MCP_ENDPOINT_PATH,
} from '../../src/mcp/endpoint'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('MCP_ENDPOINT_PATH', () => {
  test('matches the URL shipped in .mcp.json templates', () => {
    // Pins the contract: changing this constant requires updating
    // packages/cli/templates/agent/.mcp.json and examples/blog/.mcp.json.
    expect(MCP_ENDPOINT_PATH).toBe('/_guren/mcp')
  })
})

describe('isMcpEndpointEnabled', () => {
  test('is enabled only with GUREN_MCP=1 outside production', () => {
    process.env.NODE_ENV = 'development'
    process.env.GUREN_MCP = '1'
    expect(isMcpEndpointEnabled()).toBe(true)
  })

  test('is disabled without the opt-in flag', () => {
    process.env.NODE_ENV = 'development'
    delete process.env.GUREN_MCP
    expect(isMcpEndpointEnabled()).toBe(false)

    process.env.GUREN_MCP = '0'
    expect(isMcpEndpointEnabled()).toBe(false)
  })

  test('is disabled in production even with the opt-in flag', () => {
    process.env.NODE_ENV = 'production'
    process.env.GUREN_MCP = '1'
    expect(isMcpEndpointEnabled()).toBe(false)
  })

  test('reads the environment in the form the deploy bundlers substitute', async () => {
    // The deploy plugins build server code with
    // `--define 'process.env.NODE_ENV="production"'`, which matches that one
    // exact expression. `process.env?.NODE_ENV` is a different expression, so
    // an optional chain here silently turns the production gate back into a
    // runtime read — and on hosts where platform vars are not in `process.env`
    // when the module graph evaluates, that read answers "not production".
    // Runtime behaviour is identical either way, so only the source can pin it.
    const source = await readFile(join(import.meta.dir, '../../src/mcp/endpoint.ts'), 'utf8')

    expect(source).toContain('process.env.NODE_ENV')
    expect(source).not.toContain('process.env?.')
  })
})

describe('isLoopbackOrigin', () => {
  test('accepts the developer machine', () => {
    expect(isLoopbackOrigin('http://localhost:3333')).toBe(true)
    expect(isLoopbackOrigin('http://127.0.0.1:3333')).toBe(true)
    expect(isLoopbackOrigin('http://127.0.0.2')).toBe(true)
    expect(isLoopbackOrigin('https://localhost')).toBe(true)
    expect(isLoopbackOrigin('http://[::1]:3333')).toBe(true)
  })

  test('rejects remote origins', () => {
    expect(isLoopbackOrigin('http://evil.example.com')).toBe(false)
    expect(isLoopbackOrigin('https://example.com:3333')).toBe(false)
  })

  test('rejects lookalike hostnames', () => {
    expect(isLoopbackOrigin('http://localhost.evil.example.com')).toBe(false)
    expect(isLoopbackOrigin('http://notlocalhost')).toBe(false)
    expect(isLoopbackOrigin('http://127.0.0.1.evil.example.com')).toBe(false)
  })

  test('rejects opaque and malformed origins', () => {
    expect(isLoopbackOrigin('null')).toBe(false)
    expect(isLoopbackOrigin('')).toBe(false)
  })
})

describe('isLoopbackAddress', () => {
  test('accepts loopback peers in every spelling Bun reports', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.0.0.53')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
  })

  test('rejects peers elsewhere on the network', () => {
    expect(isLoopbackAddress('192.168.1.50')).toBe(false)
    expect(isLoopbackAddress('10.0.0.7')).toBe(false)
    expect(isLoopbackAddress('::ffff:192.168.1.50')).toBe(false)
    expect(isLoopbackAddress('2001:db8::1')).toBe(false)
  })
})

describe('createMcpAccessGuard', () => {
  function createGuardedApp() {
    const app = new Hono()
    app.use(MCP_ENDPOINT_PATH, createMcpAccessGuard())
    app.all(MCP_ENDPOINT_PATH, (c) => c.text('jsonrpc'))
    return app
  }

  /** Stands in for the `{ server }` env Bun.serve passes through Hono. */
  function bunEnv(address: string) {
    return { server: { requestIP: () => ({ address }) } }
  }

  test('lets MCP clients through — they send no Origin header', async () => {
    const res = await createGuardedApp().request(
      MCP_ENDPOINT_PATH,
      { method: 'POST' },
      bunEnv('127.0.0.1'),
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('jsonrpc')
  })

  test('lets local browser tooling through', async () => {
    const res = await createGuardedApp().request(
      MCP_ENDPOINT_PATH,
      { method: 'POST', headers: { Origin: 'http://localhost:6274' } },
      bunEnv('127.0.0.1'),
    )

    expect(res.status).toBe(200)
  })

  test('blocks a web page on another origin', async () => {
    // A loopback peer, so only the origin rule can produce this 403.
    const res = await createGuardedApp().request(
      MCP_ENDPOINT_PATH,
      { method: 'POST', headers: { Origin: 'http://evil.example.com' } },
      bunEnv('127.0.0.1'),
    )

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({
      message: 'Forbidden: cross-origin request to the MCP endpoint',
    })
  })

  test('blocks DNS rebinding, where the attacker host resolves to loopback', async () => {
    // The rebound page really does reach a loopback socket, so the peer check
    // passes and the origin check has to carry this one alone.
    const res = await createGuardedApp().request(
      MCP_ENDPOINT_PATH,
      { method: 'POST', headers: { Origin: 'http://rebind.evil.example.com' } },
      bunEnv('127.0.0.1'),
    )

    expect(res.status).toBe(403)
  })

  test('blocks a non-browser client elsewhere on the network', async () => {
    // Dev servers bind 0.0.0.0, and a client that sends no Origin (and forges
    // any Host it likes) is only distinguishable by its socket address.
    const res = await createGuardedApp().request(
      MCP_ENDPOINT_PATH,
      { method: 'POST', headers: { Host: 'localhost:3333' } },
      bunEnv('192.168.1.50'),
    )

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({
      message: 'Forbidden: remote request to the MCP endpoint',
    })
  })

  test('lets a loopback peer through', async () => {
    const res = await createGuardedApp().request(
      MCP_ENDPOINT_PATH,
      { method: 'POST' },
      bunEnv('127.0.0.1'),
    )

    expect(res.status).toBe(200)
  })

  test('applies to every method the transport serves', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await createGuardedApp().request(
        MCP_ENDPOINT_PATH,
        { method },
        bunEnv('192.168.1.50'),
      )

      expect(res.status).toBe(403)
    }
  })

  test('blocks a client the runtime cannot place — no Origin, no peer', async () => {
    // The hole this closes: `curl` sends no Origin, and on a host that reports
    // no peer (Node, or anything calling app.fetch() directly) both signals are
    // absent. Absent is not local, so the guard fails closed.
    delete process.env.GUREN_ALLOW_UNVERIFIED_PEER

    const res = await createGuardedApp().request(MCP_ENDPOINT_PATH, { method: 'POST' })

    expect(res.status).toBe(403)
    expect((await res.json()).message).toContain('GUREN_ALLOW_UNVERIFIED_PEER=1')
  })

  test('blocks a loopback Origin with no peer — any client can forge that header', async () => {
    delete process.env.GUREN_ALLOW_UNVERIFIED_PEER

    const res = await createGuardedApp().request(MCP_ENDPOINT_PATH, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3333' },
    })

    expect(res.status).toBe(403)
    expect((await res.json()).message).toContain('does not report the peer address')
  })

  test('blocks a peer-less request even when Bun reports a null socket', async () => {
    delete process.env.GUREN_ALLOW_UNVERIFIED_PEER

    // `requestIP()` returns null for a socket that is closed or not TCP.
    const res = await createGuardedApp().request(
      MCP_ENDPOINT_PATH,
      { method: 'POST' },
      { server: { requestIP: () => null } },
    )

    expect(res.status).toBe(403)
  })

  test('honours the explicit opt-out for runtimes with no peer info', async () => {
    process.env.GUREN_ALLOW_UNVERIFIED_PEER = '1'

    const res = await createGuardedApp().request(MCP_ENDPOINT_PATH, { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('jsonrpc')
  })

  test('the opt-out does not disable the origin or peer rules', async () => {
    process.env.GUREN_ALLOW_UNVERIFIED_PEER = '1'
    const app = createGuardedApp()

    const crossOrigin = await app.request(MCP_ENDPOINT_PATH, {
      method: 'POST',
      headers: { Origin: 'http://evil.example.com' },
    })
    expect(crossOrigin.status).toBe(403)

    const remotePeer = await app.request(
      MCP_ENDPOINT_PATH,
      { method: 'POST' },
      bunEnv('192.168.1.50'),
    )
    expect(remotePeer.status).toBe(403)
  })

  test('needs the opt-out spelled exactly 1, like every other GUREN_ flag', async () => {
    for (const value of ['0', 'true', 'yes', '']) {
      process.env.GUREN_ALLOW_UNVERIFIED_PEER = value

      const res = await createGuardedApp().request(MCP_ENDPOINT_PATH, { method: 'POST' })
      expect(res.status).toBe(403)
    }
  })

  test('reads its opt-out in the form the deploy bundlers substitute', async () => {
    // The guard's own `process.env` read carries the same constraint as the
    // endpoint gates: optional chaining puts it out of reach of a `--define`,
    // and this is the newest of the three reads, so the likeliest to be
    // "hardened" by someone who has not read the comment above it.
    const source = await readFile(
      join(import.meta.dir, '../../src/http/middleware/loopback-guard.ts'),
      'utf8',
    )

    expect(source).toContain('process.env.GUREN_ALLOW_UNVERIFIED_PEER')
    expect(source).not.toContain('process.env?.')
  })
})
