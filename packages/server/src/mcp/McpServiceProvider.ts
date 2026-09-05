import { ServiceProvider } from '../container/ServiceProvider'
import { createMcpServer } from './create-mcp-server'
import type { GurenCliApi } from './create-mcp-server'
import { createMcpAccessGuard, isMcpEndpointEnabled, MCP_ENDPOINT_PATH } from './endpoint'

/**
 * Registers the MCP endpoint at /_guren/mcp, so AI coding agents can introspect
 * the project, run integrity checks, and scaffold code. Only active while
 * `isMcpEndpointEnabled()` holds — the same `GUREN_MCP=1` opt-in that exempts
 * the endpoint from CSRF. @guren/cli is imported dynamically to break a cycle.
 */
export class McpServiceProvider extends ServiceProvider {
  register(): void {
    // Nothing to register in the container
  }

  async boot(): Promise<void> {
    if (!isMcpEndpointEnabled()) {
      return
    }

    const app = this.container.make<{ hono: import('hono').Hono }>('app')
    const hono = app.hono
    const cwd = process.cwd()

    // Dynamic imports to avoid circular dependencies and keep prod bundles clean.
    // @guren/cli is resolved at runtime (not a direct dependency of @guren/server).
    const [{ WebStandardStreamableHTTPServerTransport }, cli] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'),
      // @ts-ignore — @guren/cli is available at runtime via the app's dependencies
      (import('@guren/cli') as Promise<GurenCliApi>),
    ])

    // Bun cannot evict an ES module, so in a long-running dev server the CLI's
    // route loading would answer every request from the module graph captured at
    // the first one; route-dependent context generation therefore runs the CLI in
    // a child process (guarded: an older @guren/cli lacks the helper). guren_codegen
    // still runs in-process from that first snapshot; Vite's routeTypesPlugin repairs it.
    const routeAwareCli: GurenCliApi = cli.createFreshContextApi
      ? { ...cli, ...cli.createFreshContextApi() }
      : cli

    hono.use(MCP_ENDPOINT_PATH, createMcpAccessGuard())

    // Stateless: McpServer.connect() may be called only once per instance, so
    // each request gets a fresh server + transport pair.
    hono.all(MCP_ENDPOINT_PATH, async (c) => {
      const mcpServer = createMcpServer({ cwd, cli: routeAwareCli })
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })

      await mcpServer.connect(transport)
      return transport.handleRequest(c.req.raw)
    })
  }
}
