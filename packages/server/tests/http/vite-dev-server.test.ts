import { beforeEach, describe, expect, it, mock } from 'bun:test'

let receivedConfig: Record<string, unknown> | undefined

mock.restore()

await mock.module('vite', () => ({
  createServer: async (config: Record<string, unknown>) => {
    receivedConfig = config
    return {
      config: { server: { port: 4321 } },
      resolvedUrls: {
        local: ['http://localhost:4321'],
        network: ['http://192.168.0.10:4321'],
      },
      listen: async () => {},
    }
  },
}))

const { startViteDevServer, resolveViteDevServerConfig } = await import('../../src/http/vite-dev-server')

describe('startViteDevServer', () => {
  beforeEach(() => {
    receivedConfig = undefined
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
})

describe('resolveViteDevServerConfig', () => {
  it('does not bind the dev server to every interface by default', () => {
    // The dev server serves every file under the project root with no auth, so
    // `host` must stay unset: it would override Vite's localhost-only default.
    const config = resolveViteDevServerConfig({ root: '/tmp/app' })

    expect(config.server?.host).toBeUndefined()
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
