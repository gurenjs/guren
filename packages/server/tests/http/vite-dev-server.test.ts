import { describe, expect, it, mock } from 'bun:test'

let receivedConfig: Record<string, unknown> | undefined

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
  it('starts the dev server with merged options', async () => {
    const result = await startViteDevServer({ root: '/tmp/app', port: 4321 })

    expect(receivedConfig).toMatchObject({
      root: '/tmp/app',
      server: expect.objectContaining({ port: 4321 }),
    })
    expect(result.localUrl).toBe('http://localhost:4321')
    expect(result.networkUrls).toEqual(['http://192.168.0.10:4321'])
  })
})
