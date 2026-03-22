import { ServiceProvider } from '../container/ServiceProvider'
import { createMcpServer } from './create-mcp-server'
import type { GurenCliApi } from './create-mcp-server'

/**
 * Registers the MCP (Model Context Protocol) endpoint at /_guren/mcp.
 *
 * This provider is only active in development mode (NODE_ENV !== 'production').
 * It allows AI coding agents (Claude Code, Cursor, etc.) to introspect
 * the project structure, run integrity checks, and scaffold code.
 *
 * @guren/cli is loaded via dynamic import to avoid circular dependencies
 * (@guren/server -> @guren/cli -> @guren/core -> @guren/server).
 */
export class McpServiceProvider extends ServiceProvider {
  register(): void {
    // Nothing to register in the container
  }

  async boot(): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      return
    }

    const app = this.container.make<{ hono: import('hono').Hono }>('app')
    const hono = app.hono
    const cwd = process.cwd()

    // Dynamic imports to avoid circular dependencies and keep prod bundles clean.
    // @guren/cli is resolved at runtime (not a direct dependency of @guren/server).
    const [{ WebStandardStreamableHTTPServerTransport }, cli] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'),
      // @ts-expect-error — @guren/cli is available at runtime via the app's dependencies
      (import('@guren/cli') as Promise<GurenCliApi>),
    ])

    // Stateless mode: each request gets a fresh McpServer + transport pair.
    // McpServer.connect() can only be called once per instance, so we
    // create a new server for each request.
    hono.all('/_guren/mcp', async (c) => {
      const mcpServer = createMcpServer({ cwd, cli })
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })

      await mcpServer.connect(transport)
      return transport.handleRequest(c.req.raw)
    })
  }
}
