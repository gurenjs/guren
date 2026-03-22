import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const startViteDevServerMock = mock(async () => ({
  server: {
    close: mock(async () => {}),
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
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Bun.serve = originalServe
  })

  it('restarts the managed Vite dev server after a watch reload', async () => {
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
})
