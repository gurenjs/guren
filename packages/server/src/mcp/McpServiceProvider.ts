import { ServiceProvider } from '../container/ServiceProvider'
import type { GurenCliApi } from './create-mcp-server'
import { createMcpAccessGuard, isMcpEndpointEnabled, MCP_ENDPOINT_PATH } from './endpoint'

export const DEV_MCP_CLI_TOO_OLD =
  'GUREN_MCP=1 but the installed @guren/cli predates the 2026-07-28 MCP endpoint, so /_guren/mcp is not mounted. '
  + 'Upgrade it (bunx guren upgrade).'

/**
 * Mounts the Dev MCP endpoint at /_guren/mcp while `isMcpEndpointEnabled()` holds.
 * The server lives in @guren/cli (RFC 0028 §1), which every deploy target stubs, so
 * this package imports no MCP SDK code.
 * @experimental
 */
export class McpServiceProvider extends ServiceProvider {
  register(): void {}

  async boot(): Promise<void> {
    if (!isMcpEndpointEnabled()) {
      return
    }

    const { hono } = this.container.make<{ hono: import('hono').Hono }>('app')

    // Dynamic: @guren/cli depends on this package, and is resolved from the app.
    // Outside `mountDevEndpoint`'s load step, so a failure here is caught here:
    // a dev server must still start when its coding-agent endpoint cannot.
    let cli: GurenCliApi
    try {
      // @ts-ignore — @guren/cli is available at runtime via the app's dependencies
      cli = (await import('@guren/cli')) as GurenCliApi
    } catch (error) {
      console.warn(
        `[guren] GUREN_MCP=1 but @guren/cli could not be loaded, so /_guren/mcp is not mounted: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    if (typeof cli.createDevMcpHandler !== 'function') {
      console.warn(`[guren] ${DEV_MCP_CLI_TOO_OLD}`)
      return
    }

    const handler = cli.createDevMcpHandler({ cwd: process.cwd() })

    // The handler performs no Origin or peer validation of its own.
    hono.use(MCP_ENDPOINT_PATH, createMcpAccessGuard())
    hono.all(MCP_ENDPOINT_PATH, (c) => handler.fetch(c.req.raw))
  }
}
