import { Hono } from 'hono'
import type { MiddlewareHandler, ExecutionContext } from 'hono'
import { Route } from '../mvc/Route'
import { ApplicationContext } from '../plugins/ApplicationContext'
import { PluginManager } from '../plugins/PluginManager'
import type { Provider, ProviderConstructor } from '../plugins/Provider'
import { InertiaViewProvider } from '../plugins/providers/InertiaViewProvider'
import { AuthServiceProvider } from '../plugins/providers/AuthServiceProvider'
import { AuthManager } from '../auth'
import { logDevServerBanner, type DevBannerOptions } from './dev-banner'
import { startViteDevServer, type StartViteDevServerOptions } from './vite-dev-server'

// Bun is only available at runtime. The declaration keeps TypeScript happy while
// still allowing consumers to stub or polyfill it when running elsewhere.
declare const Bun:
  | {
    serve(options: {
      port?: number
      hostname?: string
      fetch: (request: Request) => Response | Promise<Response>
    }): { stop?: (closeConnections?: boolean) => void | Promise<void> } | undefined
  }
  | undefined

type BunServer = { stop?: (closeConnections?: boolean) => void | Promise<void> }

type GurenGlobal = typeof globalThis & {
  __gurenActiveServer?: BunServer
}

function getGlobalState(): GurenGlobal {
  return globalThis as GurenGlobal
}

async function stopActiveBunServer(): Promise<void> {
  const state = getGlobalState()
  const previous = state.__gurenActiveServer

  if (!previous?.stop) {
    state.__gurenActiveServer = undefined
    return
  }

  try {
    await Promise.resolve(previous.stop())
  } catch (error) {
    console.warn('Failed to stop previous Bun server:', error)
  } finally {
    state.__gurenActiveServer = undefined
  }
}

function setActiveBunServer(server?: BunServer): void {
  getGlobalState().__gurenActiveServer = server
}

export type BootCallback = (app: Hono) => void | Promise<void>

export interface ApplicationOptions {
  readonly boot?: BootCallback
  readonly providers?: Array<Provider | ProviderConstructor>
}

export interface ApplicationListenOptions {
  port?: number
  hostname?: string
  assetsUrl?: string
  vite?: StartViteDevServerOptions | false
}

/**
 * Application wires the Route registry into a running Hono instance.
 * It offers a small convenience layer so users can bootstrap a Bun server
 * without touching the underlying Hono object directly.
 */
export class Application {
  readonly hono: Hono
  private readonly plugins: PluginManager
  private context?: ApplicationContext
  private readonly authManager: AuthManager
  private viteDevServer?: Awaited<ReturnType<typeof startViteDevServer>>['server']
  private bunServer?: BunServer
  private viteTeardownRegistered = false
  private bunTeardownRegistered = false

  constructor(private readonly options: ApplicationOptions = {}) {
    this.hono = new Hono()
    this.authManager = new AuthManager()
    this.plugins = new PluginManager(() => this.resolveContext())

    this.registerDefaultProviders()

    if (Array.isArray(this.options.providers)) {
      this.plugins.addMany(this.options.providers)
    }
  }

  get auth(): AuthManager {
    return this.authManager
  }

  /**
   * Mounts all routes that were defined through the Route DSL.
   */
  mountRoutes(): void {
    Route.mount(this.hono)
  }

  /**
   * Allows registering global middlewares directly on the underlying Hono app.
   */
  use(path: string, ...middleware: MiddlewareHandler[]): void {
    this.hono.use(path, ...middleware)
  }

  /**
   * Executes the optional boot callback and mounts the registered routes.
   */
  async boot(): Promise<void> {
    await this.plugins.registerAll()
    await this.options.boot?.(this.hono)
    this.mountRoutes()
    await this.plugins.bootAll()
  }

  /**
   * Fetch handler to integrate with Bun.serve or any standard Fetch runtime.
   */
  async fetch(request: Request, env?: unknown, executionCtx?: ExecutionContext): Promise<Response> {
    return this.hono.fetch(request, env, executionCtx)
  }

  /**
   * Convenience helper to start a Bun server when available.
   */
  async listen(options: ApplicationListenOptions = {}): Promise<void> {
    if (!Bun) {
      throw new Error('Bun runtime is required to call Application.listen')
    }

    await stopActiveBunServer()

    const { port = 3000, hostname = '0.0.0.0', assetsUrl, vite } = options
    const envAssetsUrl =
      typeof process !== 'undefined' ? process.env?.VITE_DEV_SERVER_URL : undefined
    let resolvedAssetsUrl = assetsUrl ?? envAssetsUrl

    const shouldStartVite =
      vite !== false &&
      typeof process !== 'undefined' &&
      process.env?.NODE_ENV !== 'production' &&
      !resolvedAssetsUrl &&
      process.env?.GUREN_DEV_VITE !== '0'

    if (shouldStartVite) {
      const viteOptions: StartViteDevServerOptions | undefined =
        typeof vite === 'object' ? vite : undefined

      try {
        const { server, localUrl } = await startViteDevServer({
          root: viteOptions?.root ?? process.cwd(),
          config: viteOptions?.config,
          host: viteOptions?.host ?? true,
          port: viteOptions?.port,
        })
        this.viteDevServer = server
        resolvedAssetsUrl = localUrl
        if (typeof process !== 'undefined') {
          process.env.VITE_DEV_SERVER_URL = resolvedAssetsUrl
        }
        this.registerViteTeardown()
      } catch (error) {
        console.error('Failed to start Vite dev server:', error)
        process.exit(1)
      }
    }

    const server = Bun.serve({
      port,
      hostname,
      fetch: (request: Request) => this.fetch(request),
    })
    this.bunServer = server
    setActiveBunServer(server)
    this.registerBunTeardown()

    const shouldLogBanner =
      typeof process === 'undefined' ||
      (process.env?.NODE_ENV !== 'production' && process.env?.GUREN_DEV_BANNER !== '0')

    if (shouldLogBanner) {
      this.logDevServerBanner({
        hostname,
        port,
        assetsUrl: resolvedAssetsUrl ?? 'http://localhost:5173',
      })
    }
  }

  register(provider: Provider | ProviderConstructor): this {
    this.plugins.add(provider)
    return this
  }

  registerMany(providers: Array<Provider | ProviderConstructor>): this {
    this.plugins.addMany(providers)
    return this
  }

  /**
   * Logs the rich development server banner to the console.
   */
  logDevServerBanner(options: DevBannerOptions): void {
    logDevServerBanner(options)
  }

  private resolveContext(): ApplicationContext {
    if (!this.context) {
      this.context = new ApplicationContext(this, this.authManager)
    }

    return this.context
  }

  private registerDefaultProviders(): void {
    this.plugins.add(InertiaViewProvider)
    this.plugins.add(AuthServiceProvider)
  }

  private async closeViteDevServer(): Promise<void> {
    if (!this.viteDevServer) {
      return
    }

    try {
      await this.viteDevServer.close()
    } catch (error) {
      console.error('Error while shutting down Vite dev server:', error)
    } finally {
      this.viteDevServer = undefined
      this.viteTeardownRegistered = false
    }
  }

  private registerViteTeardown(): void {
    if (this.viteTeardownRegistered || !this.viteDevServer || typeof process === 'undefined') {
      return
    }

    this.viteTeardownRegistered = true

    const exitHandler = () => {
      this.closeViteDevServer()
        .then(() => process.exit(0))
        .catch(() => process.exit(1))
    }

    process.once('SIGINT', exitHandler)
    process.once('SIGTERM', exitHandler)
    process.on('exit', () => {
      if (this.viteDevServer) {
        void this.viteDevServer.close()
      }
    })
  }

  private registerBunTeardown(): void {
    if (this.bunTeardownRegistered || typeof process === 'undefined') {
      return
    }

    this.bunTeardownRegistered = true

    const exitHandler = () => {
      stopActiveBunServer()
        .then(() => process.exit(0))
        .catch(() => process.exit(1))
    }

    process.once('SIGINT', exitHandler)
    process.once('SIGTERM', exitHandler)
    process.on('exit', () => {
      void stopActiveBunServer()
    })
  }
}

export type { Context } from 'hono'
