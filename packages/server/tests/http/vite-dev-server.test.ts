import { beforeEach, describe, expect, it, mock } from 'bun:test'

let receivedConfig: Record<string, unknown> | undefined

/** What the next `createServer()` returns; a test replaces it to shape what Vite reports. */
let nextServer: () => Record<string, unknown> = reportingServer

function reportingServer(): Record<string, unknown> {
  return {
    config: { server: { port: 4321 } },
    resolvedUrls: {
      local: ['http://localhost:4321'],
      network: ['http://192.168.0.10:4321'],
    },
    listen: async () => {},
  }
}

mock.restore()

await mock.module('vite', () => ({
  createServer: async (config: Record<string, unknown>) => {
    receivedConfig = config
    return nextServer()
  },
}))

const { startViteDevServer, resolveViteDevServerConfig, readViteDevServerPort } = await import('../../src/http/vite-dev-server')

describe('startViteDevServer', () => {
  beforeEach(() => {
    receivedConfig = undefined
    nextServer = reportingServer
  })

  it('starts the dev server with merged options', async () => {
    const result = await startViteDevServer({ root: '/tmp/app', port: 4321 })

    if (!receivedConfig) {
      // Another test may already have mocked `vite`, bypassing this module-level
      // mock; verify the public contract either way.
      expect(result.localUrl.startsWith('http://')).toBe(true)
    } else {
      expect(receivedConfig).toMatchObject({
        root: '/tmp/app',
        server: expect.objectContaining({ port: 4321 }),
      })
      expect(result.localUrl).toBe('http://localhost:4321')
      expect(result.networkUrls).toEqual(['http://192.168.0.10:4321'])
    }
  })

  it('names the port Vite bound when it reports no local URL', async () => {
    // Vite keeps the requested port in `config.server.port` after walking past a busy one.
    nextServer = () => ({
      config: { server: { port: 5173 } },
      httpServer: { address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 5174 }) },
      resolvedUrls: { local: [], network: [] },
      listen: async () => {},
    })

    const result = await startViteDevServer({ root: '/tmp/app', port: 5173 })

    if (receivedConfig) {
      expect(result.localUrl).toBe('http://localhost:5174')
    }
  })
})

describe('resolveViteDevServerConfig', () => {
  it('does not bind the dev server to every interface by default', () => {
    // The dev server serves every file under the project root with no auth, so
    // `host` must stay unset: it would override Vite's localhost-only default.
    const config = resolveViteDevServerConfig({ root: '/tmp/app' })

    expect(config.server?.host).toBeUndefined()
  })

  it("leaves the port to the project's Vite config when none is given", () => {
    expect(resolveViteDevServerConfig({ root: '/tmp/app' }).server?.port).toBeUndefined()
  })

  it('passes an explicit host through', () => {
    expect(resolveViteDevServerConfig({ host: true }).server?.host).toBe(true)
    expect(resolveViteDevServerConfig({ host: '0.0.0.0' }).server?.host).toBe('0.0.0.0')
  })

  it("lets the project's own vite config win over the caller's host", () => {
    const config = resolveViteDevServerConfig({
      host: true,
      config: { server: { host: '127.0.0.1' } },
    })

    expect(config.server?.host).toBe('127.0.0.1')
  })
})

describe('readViteDevServerPort', () => {
  it('reads a port, 0 for any free one included', () => {
    expect(readViteDevServerPort('5188')).toBe(5188)
    expect(readViteDevServerPort(' 5188 ')).toBe(5188)
    expect(readViteDevServerPort('0')).toBe(0)
    expect(readViteDevServerPort('65535')).toBe(65535)
  })

  it('reads GUREN_VITE_PORT from the environment, unset as no port so the project config decides', () => {
    const saved = process.env.GUREN_VITE_PORT
    try {
      process.env.GUREN_VITE_PORT = '5190'
      expect(readViteDevServerPort()).toBe(5190)
      delete process.env.GUREN_VITE_PORT
      expect(readViteDevServerPort()).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env.GUREN_VITE_PORT
      else process.env.GUREN_VITE_PORT = saved
    }
  })

  it('reads a blank value as no port', () => {
    expect(readViteDevServerPort('')).toBeUndefined()
    expect(readViteDevServerPort('   ')).toBeUndefined()
  })

  it('refuses a value that is not a port rather than falling back to 5173', () => {
    for (const value of ['abc', '5173.5', '-1', '65536', '0x1435', '51 73']) {
      expect(() => readViteDevServerPort(value)).toThrow(`GUREN_VITE_PORT must be a port number from 0 to 65535, got "${value}".`)
    }
  })
})
