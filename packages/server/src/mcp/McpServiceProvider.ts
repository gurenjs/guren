import { ServiceProvider } from '../container/ServiceProvider'
import { createMcpAccessGuard, isMcpEndpointEnabled, MCP_ENDPOINT_PATH } from './endpoint'

/**
 * What this provider calls on `@guren/cli`, spelled here: the package cannot be
 * declared as a dependency (it depends on this one), so an imported type would
 * build as `any`. Same seam as `DocsViewerServiceProvider`'s.
 */
export interface DevMcpCliApi {
  createDevMcpHandler?(options: { cwd: string }): {
    fetch(request: Request): Promise<Response>
  }
}

export const DEV_MCP_CLI_TOO_OLD =
  'GUREN_MCP=1 but the installed @guren/cli predates the 2026-07-28 MCP endpoint, so /_guren/mcp is not mounted. '
  + 'Upgrade it to 2.24.0 or later (bunx guren upgrade).'

/** Whether this CLI ships the Dev MCP factory; `DEV_MCP_CLI_TOO_OLD` says what to do when it does not. */
export function canServeDevMcp(
  cli: DevMcpCliApi,
): cli is DevMcpCliApi & { createDevMcpHandler: NonNullable<DevMcpCliApi['createDevMcpHandler']> } {
  return typeof cli.createDevMcpHandler === 'function'
}

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
    let cli: DevMcpCliApi
    try {
      // @ts-ignore — @guren/cli is available at runtime via the app's dependencies
      cli = (await import('@guren/cli')) as DevMcpCliApi
    } catch (error) {
      console.warn(
        `[guren] GUREN_MCP=1 but @guren/cli could not be loaded, so /_guren/mcp is not mounted: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    if (!canServeDevMcp(cli)) {
      console.warn(`[guren] ${DEV_MCP_CLI_TOO_OLD}`)
      return
    }

    const handler = cli.createDevMcpHandler({ cwd: process.cwd() })

    // The handler performs no Origin or peer validation of its own.
    hono.use(MCP_ENDPOINT_PATH, createMcpAccessGuard())
    hono.all(MCP_ENDPOINT_PATH, (c) => handler.fetch(c.req.raw))
  }
}
