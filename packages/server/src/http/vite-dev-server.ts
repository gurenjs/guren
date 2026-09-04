import type { InlineConfig, ViteDevServer } from 'vite'

export interface StartViteDevServerOptions {
  root?: string
  config?: InlineConfig
  /**
   * What the dev server binds to. Unset it follows Vite's localhost-only
   * default, which is the safe choice: the dev server serves every file under
   * the project root, unauthenticated. Pass `true` to expose it on the network.
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
 * Build the inline config the managed dev server starts with. `server.host` is
 * left undefined unless asked for, so Vite's config merge drops it and the
 * project's own `vite.config.ts` decides.
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
