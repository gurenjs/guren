import { createMcpHandler } from '@modelcontextprotocol/server'

import { createDevMcpServer, type CreateDevMcpServerOptions } from './server'

/**
 * Reached only through `createDevMcpHandler`'s dynamic import, which is what keeps
 * the MCP SDK out of the module graph of every other `@guren/cli` consumer.
 */
export function startDevMcp(options: CreateDevMcpServerOptions) {
  return createMcpHandler(() => createDevMcpServer(options))
}
