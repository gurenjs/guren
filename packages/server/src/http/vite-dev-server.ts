import type { InlineConfig, ViteDevServer } from 'vite'

export interface StartViteDevServerOptions {
  root?: string
  config?: InlineConfig
  host?: boolean | string
  port?: number
}

export interface StartedViteDevServer {
  server: ViteDevServer
  localUrl: string
  networkUrls: string[]
}

export async function startViteDevServer(
  options: StartViteDevServerOptions = {},
): Promise<StartedViteDevServer> {
  const { root = process.cwd(), config = {}, host = true, port } = options
  const { createServer } = await import('vite')

  const mergedConfig: InlineConfig = {
    clearScreen: false,
    ...config,
    root: config.root ?? root,
    server: {
      host,
      port,
      ...(config.server ?? {}),
    },
  }

  const server = await createServer(mergedConfig)
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
