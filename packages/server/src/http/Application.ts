import { Hono } from 'hono'
import type { MiddlewareHandler, ExecutionContext } from 'hono'
import { Router } from '../mvc/Router'
import { Container, mountModuleRoutes, type ServiceProvider, type GurenModule } from '../container'
import { ProviderManager, type ServiceProviderConstructor } from '../container/ServiceProvider'
import { AuthManager } from '../auth/AuthManager'
import { AuthServiceProvider } from '../providers/AuthServiceProvider'
import { AuthorizationServiceProvider } from '../providers/AuthorizationServiceProvider'
import { ErrorServiceProvider } from '../providers/ErrorServiceProvider'
import { I18nServiceProvider } from '../providers/I18nServiceProvider'
import { InertiaServiceProvider } from '../providers/InertiaServiceProvider'
import { attachAuthContext } from './middleware/auth'
import { SessionGuard } from '../auth/SessionGuard'
import type { CreateSessionMiddlewareOptions } from './middleware/session'
import type { DetectLocaleOptions } from './middleware/detect-locale'
import type { TranslationLoader, TranslationMessages } from '../i18n'
import { createSecurityHeaders, type SecurityHeadersOptions } from './middleware/security-headers'
import { createHostAuthorizationMiddleware, type HostAuthorizationOptions } from './middleware/host-authorization'
import { isMcpEndpointEnabled } from '../mcp/endpoint'
import { isDocsViewerEnabled } from '../docs-viewer/endpoint'
import { logDevServerBanner, type DevBannerOptions } from './dev-banner'
import { startViteDevServer, type StartViteDevServerOptions } from './vite-dev-server'

// Bun is only available at runtime. The declaration keeps TypeScript happy while
// still allowing consumers to stub or polyfill it when running elsewhere.
declare const Bun:
  | {
    serve(options: {
      port?: number
      hostname?: string
      fetch: (request: Request, server: BunServer) => Response | Promise<Response>
    }): BunServer | undefined
  }
  | undefined

type BunServer = {
  stop?: (closeConnections?: boolean) => void | Promise<void>
  requestIP?: (request: Request) => { address?: string } | null
}
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
export type { ServiceProviderConstructor } from '../container/ServiceProvider'
export type RouteRegistration = (router: Router) => void | Promise<void>
export type ApplicationFeatures = Record<string, unknown>

export interface ApplicationOptions {
  readonly boot?: BootCallback
  readonly providers?: Array<ServiceProviderConstructor>
  readonly auth?: AuthPluginOptions
  /**
   * Configure internationalization: translation loading, locale detection,
   * and Inertia `_i18n` shared props. When set, {@link I18nServiceProvider}
   * is registered automatically.
   */
  readonly i18n?: I18nPluginOptions
  readonly discover?: boolean
  readonly routes?: RouteRegistration
  /**
   * Application modules (RFC 0002) — each module's providers are appended
   * to `providers` below, and its route registrar runs after `routes`
   * (wrapped in `router.group(prefix, ...)` when the module declares one).
   */
  readonly modules?: GurenModule[]
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

export interface I18nPluginOptions {
  /**
   * Locales the app supports. Locale detection only ever resolves to one of
   * these, and all of them are preloaded during `boot()`.
   */
  readonly supported: readonly string[]
  /**
   * Fallback (and default) locale. Defaults to the first supported locale.
   */
  readonly fallback?: string
  /**
   * Directory containing `<path>/<locale>/*.json` translation files, loaded
   * with {@link JsonLoader}. Defaults to `'lang'`. Ignored when `loader` is
   * set.
   */
  readonly path?: string
  /**
   * Custom translation loader (e.g. `MemoryLoader` on serverless targets
   * without a filesystem). Takes precedence over `path`.
   */
  readonly loader?: TranslationLoader
  /**
   * Preloaded messages. Locales given here count as loaded and are not
   * fetched from the loader.
   */
  readonly messages?: Record<string, TranslationMessages>
  /**
   * Locale detection middleware options. `detectLocaleMiddleware` is mounted
   * automatically with the `supported` locales above; pass `false` to mount
   * (or skip) it yourself.
   */
  readonly detect?: Omit<DetectLocaleOptions, 'supported' | 'i18n'> | false
  /**
   * Share the request locale and its messages with Inertia pages as the
   * `_i18n` prop. Defaults to `true`.
   */
  readonly share?: boolean
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

    // Register a default auth guard so requireAuthenticated/requireGuest work
    // even when apps manually wire sessions without the auth option.
    if (!this.authManager.guardNames().length) {
      this.authManager.registerGuard('web', ({ ctx, session, manager }) => {
        // Use 'users' provider if registered; otherwise create a no-op guard
        // that always returns unauthenticated (apps must register a provider
        // for actual auth to work).
        let provider: any
        try { provider = manager.getProvider('users') } catch {
          provider = { retrieveById: async () => null, retrieveByCredentials: async () => null, validateCredentials: async () => false }
        }
        return new SessionGuard({ provider, session })
      })
      this.authManager.setDefaultGuard('web')
    }

    // AuthServiceProvider (session + CSRF + auth context) is registered
    // when options.auth is set. For apps that manually wire sessions,
    // attach the auth context fallback here in the constructor so that
    // middleware registered via app.use() before boot() (e.g.
    // requireAuthenticated) still finds it. The context resolves its
    // session lazily, so running ahead of the session middleware is fine.
    if (this.options.auth) {
      this.providerManager.register(AuthServiceProvider)
    } else {
      this.hono.use('*', attachAuthContext((ctx) => this.authManager.createAuthContext(ctx)))
    }

    // Authorization gate is always available; user providers registered
    // below can resolve 'gate' from the container or use getGate().
    this.providerManager.register(AuthorizationServiceProvider)

    // Module providers register through the same registerMany() call as
    // options.providers, before the Error/Inertia override checks below —
    // so a module-supplied ErrorServiceProvider/InertiaServiceProvider
    // subclass is recognized just like a top-level one.
    const moduleProviders = (this.options.modules ?? []).flatMap((module) => module.providers)
    const userProviders = [
      ...(Array.isArray(this.options.providers) ? this.options.providers : []),
      ...moduleProviders,
    ]

    // I18n (translator binding + locale detection + Inertia shared props) is
    // registered when options.i18n is set — unless the app supplies its own
    // I18nServiceProvider subclass, which then owns the wiring.
    const hasUserI18nProvider = userProviders.some(
      (provider) => provider === I18nServiceProvider || provider.prototype instanceof I18nServiceProvider,
    )
    if (this.options.i18n && !hasUserI18nProvider) {
      this.providerManager.register(I18nServiceProvider)
    }

    // Exception rendering is on by default so HttpExceptions map to their
    // status codes (404/422/403) instead of opaque 500s. Registered before
    // user providers so a custom ErrorServiceProvider subclass wins via
    // its later hono.onError() call.
    const hasUserErrorProvider = userProviders.some(
      (provider) => provider === ErrorServiceProvider || provider.prototype instanceof ErrorServiceProvider,
    )
    if (!hasUserErrorProvider) {
      this.providerManager.register(ErrorServiceProvider)
    }

    // Register user providers
    if (userProviders.length > 0) {
      this.providerManager.registerMany(userProviders)
    }

    // Inertia validation handling (303 redirect + flashed errors) is on by
    // default so ValidationException on Inertia requests doesn't surface as a
    // raw JSON response in the client's error modal. Registered after user
    // providers: the first matching exception renderer wins, so a custom
    // ValidationException renderer registered by a user provider keeps
    // taking precedence over this default.
    const hasUserInertiaProvider = userProviders.some(
      (provider) => provider === InertiaServiceProvider || provider.prototype instanceof InertiaServiceProvider,
    )
    if (!hasUserInertiaProvider) {
      this.providerManager.register(InertiaServiceProvider)
    }
  }

  get auth(): AuthManager {
    return this.authManager
  }

  get authOptions(): AuthPluginOptions | undefined {
    return this.options.auth
  }

  get i18nOptions(): I18nPluginOptions | undefined {
    return this.options.i18n
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
    if (!this.routesRegistered) {
      if (this.options.routes) {
        // Don't clear — preserve routes added directly to app.router before boot()
        await this.options.routes(this.router)
      }

      for (const gurenModule of this.options.modules ?? []) {
        await mountModuleRoutes(this.router, gurenModule)
      }

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

    // Note: for apps without options.auth, the auth context fallback is
    // attached in the constructor so middleware registered via app.use()
    // before boot() can rely on it (see #13).

    await this.options.boot?.(this.hono)

    await this.mountRoutes()
    // MCP endpoint (/_guren/mcp): project introspection for AI agents.
    await this.mountDevEndpoint(
      isMcpEndpointEnabled(),
      async () => (await import('../mcp/McpServiceProvider')).McpServiceProvider,
      'GUREN_MCP=1 but the MCP endpoint could not load — is @modelcontextprotocol/sdk installed?',
    )
    // Docs viewer (/_guren/docs): read-only UI over the OKF docs bundle (RFC 0005).
    await this.mountDevEndpoint(
      isDocsViewerEnabled(),
      async () => (await import('../docs-viewer/DocsViewerServiceProvider')).DocsViewerServiceProvider,
      'GUREN_DOCS=1 but the docs viewer could not load — is @guren/cli resolvable from this app?',
    )
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
   * Mounts an opt-in, dev-only framework endpoint: the MCP endpoint
   * (/_guren/mcp) and the docs viewer (/_guren/docs) both work this way.
   *
   * Only the dynamic import is allowed to fail silently — these
   * providers reach optional dependencies (the MCP SDK, @guren/cli) that
   * an app need not have installed, and `missing` names that case. A
   * failure inside the provider's own boot is a real problem and is
   * rethrown, rather than leaving the developer with a silent 404.
   */
  private async mountDevEndpoint(
    enabled: boolean,
    load: () => Promise<new (container: Container) => ServiceProvider>,
    missing: string,
  ): Promise<void> {
    if (!enabled) return

    let provider: ServiceProvider
    try {
      const Provider = await load()
      provider = new Provider(this.container)
    } catch {
      console.warn(`[guren] ${missing}`)
      return
    }

    provider.register?.()
    await provider.boot?.()
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
      // `{ server }` is Bun's convention for reaching the live server from a
      // handler; middleware reads `ctx.env.server.requestIP()` through it to
      // learn the socket peer (the MCP access guard, the rate limiter).
      fetch: (request: Request, server: BunServer) => this.fetch(request, { server }),
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
