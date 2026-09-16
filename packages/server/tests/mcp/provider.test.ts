import { describe, expect, test } from 'bun:test'

import { canServeDevMcp, DEV_MCP_CLI_TOO_OLD } from '../../src/mcp/McpServiceProvider'

// The wiring against a real @guren/cli is covered where that package is installed
// (packages/cli/tests/dev-mcp-provider.test.ts). What is left here is the decision
// itself, which a module mock cannot reach: another test file in this process
// imports @guren/cli for its own reasons, and the real one ships the factory.
describe('canServeDevMcp', () => {
  test('rejects a @guren/cli that predates createDevMcpHandler', () => {
    expect(canServeDevMcp({})).toBe(false)
    expect(canServeDevMcp({ createDevMcpHandler: undefined })).toBe(false)
  })

  test('accepts a CLI that exports the factory', () => {
    expect(canServeDevMcp({ createDevMcpHandler: () => ({ fetch: async () => new Response() }) })).toBe(true)
  })

  test('names the upgrade that fixes it', () => {
    expect(DEV_MCP_CLI_TOO_OLD).toContain('bunx guren upgrade')
  })
})
