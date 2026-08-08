import type { InlineConfig, ViteDevServer } from 'vite'

export interface StartViteDevServerOptions {
  root?: string
  config?: InlineConfig
  /**
   * What the dev server binds to. Left unset it follows Vite's own
   * localhost-only default, which is the safe choice: the dev server serves
   * every file under the project root, including the default SQLite database,
   * with no authentication. Pass `true` to expose it on the network.
   */
  host?: boolean | string
  port?: number
}

export interface StartedViteDevServer {
  server: ViteDevServer
  localUrl: string
  networkUrls: string[]
}

/**
 * Build the inline config the managed dev server starts with.
 *
 * `server.host` is only set when the caller asked for one. Left undefined it
 * is dropped during Vite's config merge, so the project's own `vite.config.ts`
 * decides, falling back to Vite's localhost-only default.
 */
export function resolveViteDevServerConfig(
  options: StartViteDevServerOptions = {},
): InlineConfig {
  const { root = process.cwd(), config = {}, host, port } = options

  return {
    clearScreen: false,
    ...config,
    root: config.root ?? root,
    server: {
      host,
      port,
      ...(config.server ?? {}),
    },
  }
}

export async function startViteDevServer(
  options: StartViteDevServerOptions = {},
): Promise<StartedViteDevServer> {
  const { host, port } = options
  const { createServer } = await import('vite')

  const server = await createServer(resolveViteDevServerConfig(options))
  await server.listen()

  const resolved = server.resolvedUrls
  const localUrls = resolved?.local?.length
    ? resolved.local
    : [`http://${typeof host === 'string' ? host : 'localhost'}:${server.config.server.port ?? port ?? 5173}`]
  const networkUrls = resolved?.network ?? []

  return {
    server,
    localUrl: localUrls[0],
    networkUrls,
  }
}
