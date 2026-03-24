import { Hono } from 'hono'
import type { MiddlewareHandler, ExecutionContext } from 'hono'
import { Router } from '../mvc/Router'
import { Container, type ServiceProvider } from '../container'
import { ProviderManager } from '../container/ServiceProvider'
import { AuthManager } from '../auth'
import type { CreateSessionMiddlewareOptions } from './middleware/session'
import { createSecurityHeaders, type SecurityHeadersOptions } from './middleware/security-headers'
import { createHostAuthorizationMiddleware, type HostAuthorizationOptions } from './middleware/host-authorization'
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
type ViteServer = Awaited<ReturnType<typeof startViteDevServer>>['server']
const MANAGED_VITE_ENV_FLAG = 'GUREN_MANAGED_VITE_DEV_SERVER'
const DEFAULT_DEV_ENTRY_PATH = '/resources/js/dev-entry.ts'

function clearManagedViteEnv(): void {
  if (typeof process === 'undefined') {
    return
  }

  if (process.env[MANAGED_VITE_ENV_FLAG] === '1') {
    delete process.env.VITE_DEV_SERVER_URL
  }

  delete process.env[MANAGED_VITE_ENV_FLAG]
}

function normalizeDevEntryUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/u, '')}${DEFAULT_DEV_ENTRY_PATH}`
}

function syncManagedInertiaDevEntry(devServerUrl: string): void {
  if (typeof process === 'undefined') {
    return
  }

  const nextEntry = normalizeDevEntryUrl(devServerUrl)
  const currentEntry = process.env.GUREN_INERTIA_ENTRY

  if (!currentEntry || currentEntry.endsWith(DEFAULT_DEV_ENTRY_PATH)) {
    process.env.GUREN_INERTIA_ENTRY = nextEntry
  }
}

type GurenGlobal = typeof globalThis & {
  __gurenActiveServer?: BunServer
  __gurenActiveViteDevServer?: ViteServer
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

async function stopActiveViteDevServer(): Promise<void> {
  const state = getGlobalState()
  const previous = state.__gurenActiveViteDevServer

  if (!previous) {
    state.__gurenActiveViteDevServer = undefined
    clearManagedViteEnv()
    return
  }

  try {
    await previous.close()
  } catch (error) {
    console.warn('Failed to stop previous Vite dev server:', error)
  } finally {
    state.__gurenActiveViteDevServer = undefined
    clearManagedViteEnv()
  }
}

function setActiveViteDevServer(server?: ViteServer): void {
  getGlobalState().__gurenActiveViteDevServer = server
}

export type BootCallback = (app: Hono) => void | Promise<void>

/**
 * Service provider class constructor type.
 */
export type ServiceProviderConstructor = new (container: Container) => ServiceProvider
export type RouteRegistration = (router: Router) => void | Promise<void>
export type ApplicationFeatures = Record<string, unknown>

export interface ApplicationOptions {
  readonly boot?: BootCallback
  readonly providers?: Array<ServiceProviderConstructor>
  readonly auth?: AuthPluginOptions
  readonly discover?: boolean
  readonly routes?: RouteRegistration
  readonly features?: ApplicationFeatures
  /**
   * Configure or disable the default security headers middleware.
   * Set to `false` to disable entirely, or pass `SecurityHeadersOptions` to customize.
   * Enabled by default with safe Rails-matching defaults.
   */
  readonly securityHeaders?: SecurityHeadersOptions | false
  /**
   * Configure host authorization middleware for DNS rebinding protection.
   * Pass `HostAuthorizationOptions` to enable, or `false` / omit to disable.
   * The `create-app` template includes a default localhost configuration.
   */
  readonly hostAuthorization?: HostAuthorizationOptions | false
}

export interface AuthPluginOptions {
  autoSession?: boolean
  sessionOptions?: CreateSessionMiddlewareOptions
  /**
   * Automatically register CSRF middleware when session is enabled.
   * Defaults to `true`. Set to `false` to disable (e.g., for pure API servers).
   */
  autoCsrf?: boolean
  /**
   * Options passed to the CSRF middleware when `autoCsrf` is enabled.
   */
  csrfOptions?: import('./middleware/csrf').CsrfOptions
}

export interface ApplicationListenOptions {
  port?: number
  hostname?: string
  assetsUrl?: string
  vite?: StartViteDevServerOptions | false
}

/**
 * Application wires an app-local router into a running Hono instance.
 *
 * It embeds a DI Container as the backbone of the framework, binding core
 * services and managing providers through the container's ProviderManager.
 */
export class Application {
  readonly hono: Hono
  readonly container: Container
  readonly router: Router
  private readonly providerManager: ProviderManager
  private readonly authManager: AuthManager
  private viteDevServer?: ViteServer
  private bunServer?: BunServer
  private viteTeardownRegistered = false
  private bunTeardownRegistered = false
  private autoSessionAttached = false
  private routesRegistered = false

  constructor(private readonly options: ApplicationOptions = {}) {
    this.hono = new Hono()
    this.container = new Container()
    this.router = new Router()
    this.authManager = new AuthManager()
    this.providerManager = new ProviderManager(this.container)

    // Bind core instances
    this.container.instance('app', this as Application)
    this.container.instance('hono', this.hono)
    this.container.instance('auth', this.authManager)
    this.container.instance('router', this.router)

    // Register user providers
    if (Array.isArray(this.options.providers)) {
      this.providerManager.registerMany(this.options.providers)
    }
  }

  get auth(): AuthManager {
    return this.authManager
  }

  get authOptions(): AuthPluginOptions | undefined {
    return this.options.auth
  }

  markAutoSessionAttached(): void {
    this.autoSessionAttached = true
  }

  hasAutoSessionAttached(): boolean {
    return this.autoSessionAttached
  }

  /**
   * Mounts the application router onto the Hono instance.
   */
  async mountRoutes(): Promise<void> {
    if (this.options.routes && !this.routesRegistered) {
      this.router.clear()
      await this.options.routes(this.router)
      this.routesRegistered = true
    }

    this.router.mount(this.hono, { container: this.container })
  }

  /**
   * Allows registering global middlewares directly on the underlying Hono app.
   */
  use(path: string, ...middleware: MiddlewareHandler[]): void {
    this.hono.use(path, ...middleware)
  }

  /**
   * Executes provider registration, boot callback, mounts routes, and boots providers.
   */
  async boot(): Promise<void> {
    this.mountSecurityDefaults()
    await this.providerManager.registerAll()
    await this.options.boot?.(this.hono)
    await this.mountRoutes()
    await this.mountMcpEndpoint()
    await this.providerManager.bootAll()
  }

  /**
   * Registers default security middleware (headers + host authorization).
   */
  private mountSecurityDefaults(): void {
    // Security headers (default: enabled)
    const { securityHeaders } = this.options
    if (securityHeaders !== false) {
      this.hono.use('*', createSecurityHeaders(securityHeaders ?? {}))
    }

    // Host authorization (default: enabled in non-production)
    this.mountHostAuthorization()
  }

  private mountHostAuthorization(): void {
    const { hostAuthorization } = this.options

    if (hostAuthorization === false || !hostAuthorization) return

    this.hono.use('*', createHostAuthorizationMiddleware(hostAuthorization))
  }

  /**
   * Mounts the MCP endpoint at /_guren/mcp in development mode.
   * This allows AI coding agents to introspect the project.
   */
  private async mountMcpEndpoint(): Promise<void> {
    if (
      typeof process === 'undefined' ||
      process.env?.NODE_ENV === 'production' ||
      process.env?.GUREN_MCP === '0'
    ) {
      return
    }

    try {
      const { McpServiceProvider } = await import('../mcp/McpServiceProvider')
      const provider = new McpServiceProvider(this.container)
      provider.register()
      await provider.boot()
    } catch {
      // MCP SDK not installed or failed to load — skip silently
    }
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
    await stopActiveViteDevServer()

    const { port = 3000, hostname = '0.0.0.0', assetsUrl, vite } = options
    const externalAssetsUrl =
      typeof process !== 'undefined' && process.env?.[MANAGED_VITE_ENV_FLAG] !== '1'
        ? process.env?.VITE_DEV_SERVER_URL
        : undefined
    let resolvedAssetsUrl = assetsUrl ?? externalAssetsUrl

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
        await this.closeViteDevServer()
        const { server, localUrl } = await startViteDevServer({
          root: viteOptions?.root ?? process.cwd(),
          config: viteOptions?.config,
          host: viteOptions?.host ?? true,
          port: viteOptions?.port,
        })
        this.viteDevServer = server
        setActiveViteDevServer(server)
        resolvedAssetsUrl = localUrl
        if (typeof process !== 'undefined') {
          process.env.VITE_DEV_SERVER_URL = resolvedAssetsUrl
          process.env[MANAGED_VITE_ENV_FLAG] = '1'
        }
        syncManagedInertiaDevEntry(resolvedAssetsUrl)
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

  /**
   * Register a service provider.
   */
  register(provider: ServiceProviderConstructor): this {
    this.providerManager.register(provider)
    return this
  }

  /**
   * Register multiple service providers.
   */
  registerMany(providers: Array<ServiceProviderConstructor>): this {
    this.providerManager.registerMany(providers)
    return this
  }

  /**
   * Logs the rich development server banner to the console.
   */
  logDevServerBanner(options: DevBannerOptions): void {
    logDevServerBanner(options)
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
      if (getGlobalState().__gurenActiveViteDevServer === this.viteDevServer) {
        setActiveViteDevServer()
      }
      this.viteDevServer = undefined
      this.viteTeardownRegistered = false
      clearManagedViteEnv()
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

export function createApp(options: ApplicationOptions = {}): Application {
  return new Application(options)
}

export type { Context } from 'hono'
