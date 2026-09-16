import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createApp } from '@guren/core'

import { connectDevMcpClient, DEV_MCP_ENDPOINT, LOOPBACK_ENV } from './dev-mcp-client'

const originalEnv = { ...process.env }

beforeEach(() => {
  process.env.NODE_ENV = 'development'
  process.env.GUREN_MCP = '1'
})

afterEach(() => {
  process.env = { ...originalEnv }
})

type BootedApp = ReturnType<typeof createApp>

async function bootApp(): Promise<BootedApp> {
  const app = createApp({})
  await app.boot()
  return app
}

// Through the real wiring: createApp() mounts McpServiceProvider, which imports
// this package by name and mounts the handler it builds (RFC 0028 §1).
describe('the Dev MCP endpoint mounted by an app', () => {
  for (const era of ['modern', 'legacy'] as const) {
    test(`serves a ${era} client at /_guren/mcp`, async () => {
      const app = await bootApp()
      const client = await connectDevMcpClient(
        (request) => app.fetch(request, LOOPBACK_ENV),
        era,
      )

      const { tools } = await client.listTools()

      expect(client.getProtocolEra()).toBe(era)
      expect(tools.map((tool) => tool.name)).toContain('guren_get_context')

      await client.close()
    })
  }

  test('keeps the loopback guard in front of the handler', async () => {
    const app = await bootApp()

    const response = await app.fetch(
      new Request(DEV_MCP_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
      { server: { requestIP: () => ({ address: '192.168.1.50' }) } },
    )

    expect(response.status).toBe(403)
  })

  test('is not mounted without the opt-in', async () => {
    delete process.env.GUREN_MCP
    const app = await bootApp()

    const response = await app.fetch(new Request(DEV_MCP_ENDPOINT, { method: 'POST' }), LOOPBACK_ENV)

    expect(response.status).toBe(404)
  })
})
