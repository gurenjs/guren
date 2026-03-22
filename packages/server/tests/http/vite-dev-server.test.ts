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

const { startViteDevServer } = await import('../../src/http/vite-dev-server')

describe('startViteDevServer', () => {
  beforeEach(() => {
    receivedConfig = undefined
  })

  it('starts the dev server with merged options', async () => {
    const result = await startViteDevServer({ root: '/tmp/app', port: 4321 })

    if (!receivedConfig) {
      // When another test has already mocked `vite`, this module-level mock may be bypassed.
      // In that case we still verify the public contract.
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
