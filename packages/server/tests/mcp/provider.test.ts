import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { Hono } from 'hono'

import { Container } from '../../src/container/Container'
import { DEV_MCP_CLI_TOO_OLD, McpServiceProvider } from '../../src/mcp/McpServiceProvider'

const originalEnv = { ...process.env }

beforeEach(() => {
  process.env.NODE_ENV = 'development'
  process.env.GUREN_MCP = '1'
})

afterEach(() => {
  process.env = { ...originalEnv }
  mock.restore()
})

function bootProvider(): { hono: Hono; boot: Promise<void> } {
  const hono = new Hono()
  const container = new Container()
  container.instance('app', { hono })
  return { hono, boot: new McpServiceProvider(container).boot() }
}

// An app can pin a @guren/cli older than this server: the endpoint stays
// unmounted with a warning naming the fix, and the dev server still boots.
describe('McpServiceProvider with a @guren/cli that predates createDevMcpHandler', () => {
  test('warns and leaves /_guren/mcp unmounted', async () => {
    await mock.module('@guren/cli', () => ({ runCheck: async () => ({}) }))
    const warn = spyOn(console, 'warn').mockImplementation(() => {})

    const { hono, boot } = bootProvider()
    await boot

    expect(warn).toHaveBeenCalledWith(`[guren] ${DEV_MCP_CLI_TOO_OLD}`)
    const response = await hono.request('/_guren/mcp', { method: 'POST' })
    expect(response.status).toBe(404)
  })
})
