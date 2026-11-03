import type { InlineConfig, ViteDevServer } from 'vite'
import { closeViteDevServerBounded } from './server-lifecycle'

/**
 * The port `listen()` starts its managed Vite dev server on. `guren browser:serve`
 * restates the name in packages/cli/src/browser-serve.ts; tests/browser-serve.test.ts pins the two.
 */
export const VITE_PORT_ENV = 'GUREN_VITE_PORT'

export interface StartViteDevServerOptions {
  root?: string
  config?: InlineConfig
  /**
   * What the dev server binds to. Unset it follows Vite's localhost-only
   * default, which is the safe choice: the dev server serves every file under
   * the project root, unauthenticated. Pass `true` to expose it on the network.
   */
  host?: boolean | string
  /**
   * The port Vite tries first, moving to the next free one when it is busy unless
   * the project sets `server.strictPort`. `listen()` falls back to `GUREN_VITE_PORT`,
   * then to the project's Vite config (5173 with the Guren plugin).
   */
  port?: number
}

export interface StartedViteDevServer {
  server: ViteDevServer
  /** Names the port Vite bound, which is not the one asked for after a walk. */
  localUrl: string
  networkUrls: string[]
}

/**
 * `GUREN_VITE_PORT` as a port, or `undefined` when it is unset or blank, so the
 * project's Vite config decides. Throws on anything else: a typo silently
 * ignored would put two apps back on the same port.
 */
export function readViteDevServerPort(
  value: string | undefined = typeof process === 'undefined' ? undefined : process.env[VITE_PORT_ENV],
): number | undefined {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }

  const port = /^\d{1,5}$/u.test(trimmed) ? Number(trimmed) : Number.NaN
  if (!(port <= 65535)) {
    throw new Error(`${VITE_PORT_ENV} must be a port number from 0 to 65535, got "${value}".`)
  }

  return port
}

/**
 * Build the inline config the managed dev server starts with. `server.host` is
 * left undefined unless asked for, so Vite's config merge drops it and the
 * project's own `vite.config.ts` decides; `server.port` likewise.
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
      ...config.server,
    },
  }
}

/** The port the HTTP server is bound to; Vite keeps the requested one in `config.server.port`. */
function boundPort(server: ViteDevServer): number | undefined {
  const address = server.httpServer?.address()
  return typeof address === 'object' && address ? address.port : undefined
}

export async function startViteDevServer(
  options: StartViteDevServerOptions = {},
): Promise<StartedViteDevServer> {
  const { host, port } = options
  const { createServer } = await import('vite')

  const server = await createServer(resolveViteDevServerConfig(options))
  try {
    await server.listen()

    const resolved = server.resolvedUrls
    const localUrls = resolved?.local?.length
      ? resolved.local
      : [`http://${typeof host === 'string' ? host : 'localhost'}:${boundPort(server) ?? server.config.server.port ?? port ?? 5173}`]
    const networkUrls = resolved?.network ?? []

    return {
      server,
      localUrl: localUrls[0],
      networkUrls,
    }
  } catch (error) {
    await closeViteDevServerBounded(server)
    throw error
  }
}
