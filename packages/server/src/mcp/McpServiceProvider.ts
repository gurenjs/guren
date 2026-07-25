import { ServiceProvider } from '../container/ServiceProvider'
import { createMcpServer } from './create-mcp-server'
import type { GurenCliApi } from './create-mcp-server'
import { createMcpAccessGuard, isMcpEndpointEnabled, MCP_ENDPOINT_PATH } from './endpoint'

/**
 * Registers the MCP (Model Context Protocol) endpoint at /_guren/mcp.
 *
 * Only active while `isMcpEndpointEnabled()` holds, so registering this
 * provider directly honours the same `GUREN_MCP=1` opt-in that `Application`
 * gates on — and the same condition that exempts the endpoint from CSRF.
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

    // This provider lives inside a long-running dev server, so the CLI's
    // route loading — which imports routes/web.ts and everything it reaches —
    // would answer every request from the module graph captured at the first
    // one. Bun offers no way to evict an ES module, so route-dependent
    // context generation runs the CLI in a child process instead. Guarded
    // because @guren/cli is resolved from the app and may predate the helper;
    // an older CLI keeps the previous in-process (stale) behaviour rather
    // than failing outright.
    //
    // guren_codegen (generateRouteTypes et al.) has the same staleness
    // exposure and is still left in-process here, so the route-derived
    // artifacts it writes — routes.gen.ts, routes.d.ts, api-client.gen.ts —
    // describe the graph as of this process's first route load. It now writes
    // with `force`, so that snapshot overwrites what is on disk instead of
    // failing the way it used to. Page, data, and channel manifests are
    // unaffected: those generators re-scan the filesystem on every call.
    //
    // An app using the default Vite setup repairs the difference on the next
    // save, because routeTypesPlugin's handleHotUpdate spawns `guren codegen`
    // in a child process. A dev server running without that plugin has no
    // such repair, and there MCP-driven codegen is the only writer. Moving
    // codegen behind the same child process is tracked separately.
    const routeAwareCli: GurenCliApi = cli.createFreshContextApi
      ? { ...cli, ...cli.createFreshContextApi() }
      : cli

    hono.use(MCP_ENDPOINT_PATH, createMcpAccessGuard())

    // Stateless mode: each request gets a fresh McpServer + transport pair.
    // McpServer.connect() can only be called once per instance, so we
    // create a new server for each request.
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
