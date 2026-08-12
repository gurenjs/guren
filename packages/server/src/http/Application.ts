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
import type { TranslationLoader } from '../i18n'
import { createSecurityHeaders, type SecurityHeadersOptions } from './middleware/security-headers'
import { createHostAuthorizationMiddleware, type HostAuthorizationOptions } from './middleware/host-authorization'
import { isMcpEndpointEnabled } from '../mcp/endpoint'
import { isDocsViewerEnabled } from '../docs-viewer/endpoint'
import {
  formatHostPort,
  isWildcardHost,
  logDevServerBanner,
  type DevBannerOptions,
} from './dev-banner'
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
  port?: number
  hostname?: string
}
type ViteServer = Awaited<ReturnType<typeof startViteDevServer>>['server']
const MANAGED_VITE_ENV_FLAG = 'GUREN_MANAGED_VITE_DEV_SERVER'
const DEFAULT_DEV_ENTRY_PATH = '/resources/js/dev-entry.ts'

/**
 * Opt-in strict port binding.
 *
 * Pairs with the `portFallback` option exactly as `GUREN_DEV_VITE=0` pairs
 * with `vite: false` a few lines below: the env var can only *subtract* the
 * convenience, never switch it on, so an operator can pin a port from outside
 * an app whose entrypoint they don't want to edit. That is the case the walk
 * actively harms — a smoke script, a Playwright `webServer`, a CI job — while
 * `bun run dev` keeps the convenience by default.
 *
 * Spelled `=== '1'` rather than following `GUREN_DEV_*`'s `!== '0'` because a
 * harness reads more clearly as adding a guarantee than as removing a comfort.
 * Deliberately not `GUREN_PORT_FALLBACK=0`: that would sit next to `PORT=0`
 * with two unrelated meanings of zero.
 */
const STRICT_PORT_ENV_FLAG = 'GUREN_STRICT_PORT'

/**
 * Total bind attempts when the walk is enabled — the requested port plus 19
 * more. Counts *attempts*, not offsets, so it matches the loop in the starter
 * templates one-for-one; an off-by-one here means a scaffolded app and the
 * framework give up on different ports.
 */
const DEFAULT_PORT_WALK_ATTEMPTS = 20

function isAddressInUse(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EADDRINUSE',
  )
}

/**
 * How many ports `listen()` may try in total, counting the requested one.
 *
 * `PORT=0` means "let the OS pick a free port", so there is no such thing as
 * EADDRINUSE to recover from — and walking would march into 1, 2, 3, which are
 * privileged. The walk is therefore skipped outright for 0 rather than merely
 * being unreachable.
 */
function resolvePortAttempts(option: boolean | undefined, port: number): number {
  if (port === 0) {
    return 1
  }

  if (typeof process !== 'undefined' && process.env?.[STRICT_PORT_ENV_FLAG] === '1') {
    return 1
  }

  if (typeof option === 'boolean') {
    return option ? DEFAULT_PORT_WALK_ATTEMPTS : 1
  }

  // Unset: convenience while developing, fail fast in production. Read without
  // an optional chain so the deploy plugins' `--define` can settle it at bundle
  // time; the `typeof process` check already covers runtimes with no `process`.
  return typeof process !== 'undefined' && process.env.NODE_ENV === 'production'
    ? 1
    : DEFAULT_PORT_WALK_ATTEMPTS
}

/**
 * A wildcard bind is reached through a loopback address of the same family.
 *
 * Deliberately not `localhost`: that name resolves to whichever family the
 * host prefers, so an IPv4-only `0.0.0.0` bind can hand back a URL a client
 * tries over `::1` and fails to reach.
 */
function toConnectableUrl(hostname: string, port: number): string {
  const host = isWildcardHost(hostname) ? (hostname === '::' ? '::1' : '127.0.0.1') : hostname
  return `http://${formatHostPort(host, port)}`
}

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
  __gurenActiveViteDevServerUrl?: string
}

function getGlobalState(): GurenGlobal {
  return globalThis as GurenGlobal
}

async function stopActiveBunServer(closeActiveConnections = false): Promise<void> {
  const state = getGlobalState()
  const previous = state.__gurenActiveServer

  if (!previous?.stop) {
    state.__gurenActiveServer = undefined
    return
  }

  try {
    await Promise.resolve(previous.stop(closeActiveConnections))
  } catch (error) {
    console.warn('Failed to stop previous Bun server:', error)
  } finally {
    state.__gurenActiveServer = undefined
  }
}

function setActiveBunServer(server?: BunServer): void {
  getGlobalState().__gurenActiveServer = server
}

/**
 * How long a Vite `close()` may take before shutdown abandons it. Vite waits
 * for every open connection, and a browser tab holding its HMR socket can keep
 * that wait alive indefinitely. An abandoned (still-listening) old asset
 * server is recoverable noise; a `listen()` that never returns is not — the
 * Bun server is already stopped by the time Vite is torn down, so hanging here
 * leaves the process alive with no HTTP listener at all.
 */
function viteCloseTimeoutMs(): number {
  const parsed =
    typeof process !== 'undefined'
      ? Number.parseInt(process.env.GUREN_VITE_CLOSE_TIMEOUT_MS ?? '', 10)
      : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5000
}

/**
 * `close()` bounded by {@link viteCloseTimeoutMs}: resolves once the server
 * closed, failed to close (warned), or ran out the clock (warned, abandoned).
 * Every shutdown path shares this — the exit handlers and the bind-failure
 * cleanup hang on a held HMR socket exactly like a hot reload does.
 */
async function closeViteDevServerBounded(server: ViteServer): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const close = server.close().catch((error: unknown) => {
    console.warn('Failed to stop Vite dev server:', error)
  })

  try {
    const timeoutMs = viteCloseTimeoutMs()
    const timedOut = await Promise.race([
      close.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs)
      }),
    ])

    if (timedOut) {
      console.warn(
        `Vite dev server did not close within ${timeoutMs}ms — abandoning it. A stale asset server may still hold its port.`,
      )
    }
  } finally {
    clearTimeout(timer)
  }
}

async function stopActiveViteDevServer(): Promise<void> {
  const previous = getGlobalState().__gurenActiveViteDevServer

  try {
    if (previous) {
      await closeViteDevServerBounded(previous)
    }
  } finally {
    setActiveViteDevServer()
    clearManagedViteEnv()
  }
}

function setActiveViteDevServer(server?: ViteServer, localUrl?: string): void {
  const state = getGlobalState()
  state.__gurenActiveViteDevServer = server
  state.__gurenActiveViteDevServerUrl = server ? localUrl : undefined
}

/**
 * The managed Vite dev server a previous `listen()` left running in this same
 * process — `bun --hot` re-runs the entrypoint but preserves `globalThis`.
 * Reusing it keeps the browser's HMR socket connected and avoids the Vite
 * `close()` wait described on {@link viteCloseTimeoutMs}. Explicit `vite`
 * options veto reuse: the running server was built from the *previous* call's
 * options, and this call's may differ.
 */
function reusableActiveViteDevServer(
  viteOption: ApplicationListenOptions['vite'],
): { server: ViteServer; localUrl: string } | undefined {
  if (typeof viteOption === 'object') {
    return undefined
  }

  const state = getGlobalState()
  const server = state.__gurenActiveViteDevServer
  const localUrl = state.__gurenActiveViteDevServerUrl

  if (!server || !localUrl || !server.httpServer?.listening) {
    return undefined
  }

  return { server, localUrl }
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
   *
   * Framework tooling (typed keys from `guren codegen`, `guren check
   * --i18n`, the Vite watch) assumes the default `lang/` location — a
   * custom path or loader opts out of those.
   */
  readonly path?: string
  /**
   * Custom translation loader (e.g. `MemoryLoader` for bundled messages on
   * serverless targets without a filesystem). Takes precedence over `path`.
   */
  readonly loader?: TranslationLoader
  /**
   * Locale detection middleware options. `detectLocaleMiddleware` is mounted
   * automatically with the `supported` locales and `fallback` above; pass
   * `false` to mount (or skip) it yourself.
   */
  readonly detect?: Omit<DetectLocaleOptions, 'supported' | 'fallback' | 'i18n'> | false
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
  /**
   * What to do when the requested port is already taken.
   *
   * `true` walks forward through the next 20 ports; `false` fails fast with
   * the original EADDRINUSE. Unset walks outside production, matching the loop
   * this option replaces.
   *
   * `GUREN_STRICT_PORT=1` forces fail-fast regardless, and `port: 0` never
   * walks — the OS is already picking a free port.
   */
  portFallback?: boolean
}

/**
 * Where the server actually ended up listening.
 *
 * Returned by {@link Application.listen} so callers never have to infer the
 * port from the port they asked for — with a port walk or `PORT=0` in play,
 * those are different numbers, and scraping the human-readable dev banner is
 * the only alternative.
 *
 * Read-only because {@link Application.address} hands back the very object
 * `listen()` returned: a caller that adjusted its own copy would change what
 * every later reader sees.
 */
export interface ListenAddress {
  /**
   * The port the socket is bound to — what the runtime reports, falling back
   * to the port the successful `Bun.serve` call was made with.
   */
  readonly port: number
  /** The hostname the socket is bound to. */
  readonly hostname: string
  /** A URL that reaches the server, with a wildcard bind resolved to localhost. */
  readonly url: string
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
  private boundAddress?: ListenAddress
  private viteTeardownRegistered = false
  private bunTeardownRegistered = false
  private autoSessionAttached = false
  private routesRegistered = false
  private bootPromise?: Promise<void>

  constructor(private readonly options: ApplicationOptions = {}) {
    this.hono = new Hono()
    this.container = new Container()
    this.router = new Router()
    this.authManager = new AuthManager()
    this.providerManager = new ProviderManager(this.container)

    // Security defaults are mounted here rather than in boot() on purpose.
    // Hono composes the handlers it matched in registration order, so a route
    // or middleware the app registers before boot() would otherwise run ahead
    // of these and answer the request without them — which is exactly what the
    // scaffolded templates do, calling autoConfigureInertiaAssets() at module
    // scope to register the asset routes before bootstrap() awaits boot().
    // Registering first here is the only ordering an app cannot get in front of.
    this.mountSecurityDefaults()

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

    // A user-supplied subclass of a default provider takes ownership of that
    // subsystem's wiring, so the default registration below is skipped.
    const hasUserProviderOf = (base: ServiceProviderConstructor): boolean =>
      userProviders.some((provider) => provider === base || provider.prototype instanceof base)

    // I18n (translator binding + locale detection + Inertia shared props) is
    // registered when options.i18n is set.
    if (this.options.i18n && !hasUserProviderOf(I18nServiceProvider)) {
      this.providerManager.register(I18nServiceProvider)
    }

    // Exception rendering is on by default so HttpExceptions map to their
    // status codes (404/422/403) instead of opaque 500s. Registered before
    // user providers so a custom ErrorServiceProvider subclass wins via
    // its later hono.onError() call.
    if (!hasUserProviderOf(ErrorServiceProvider)) {
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
    if (!hasUserProviderOf(InertiaServiceProvider)) {
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
   *
   * Booting twice is a no-op: the first call's promise is reused, so providers
   * and routes are never mounted a second time — including when two callers
   * boot concurrently, before the first has finished. A boot that throws is not
   * remembered, so a later call attempts boot again (it resumes on a partially
   * mounted app rather than starting clean). The security defaults are mounted
   * by the constructor and so are outside this entirely.
   */
  async boot(): Promise<void> {
    this.bootPromise ??= this.bootOnce()

    try {
      await this.bootPromise
    } catch (error) {
      this.bootPromise = undefined
      throw error
    }
  }

  private async bootOnce(): Promise<void> {
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
   *
   * Called once, from the constructor — see the note there for why it does
   * not belong in boot().
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
  async listen(options: ApplicationListenOptions = {}): Promise<ListenAddress> {
    if (!Bun) {
      throw new Error('Bun runtime is required to call Application.listen')
    }

    // Force-close: this path only runs when a previous `listen()` in the same
    // process is being replaced (`bun --hot` re-running the entrypoint), and a
    // dev reload must not wait on whatever requests the old server still holds.
    await stopActiveBunServer(true)

    const { port = 3000, hostname = '0.0.0.0', assetsUrl, vite, portFallback } = options
    const externalAssetsUrl =
      typeof process !== 'undefined' && process.env?.[MANAGED_VITE_ENV_FLAG] !== '1'
        ? process.env?.VITE_DEV_SERVER_URL
        : undefined
    let resolvedAssetsUrl = assetsUrl ?? externalAssetsUrl

    const shouldStartVite =
      vite !== false &&
      typeof process !== 'undefined' &&
      process.env.NODE_ENV !== 'production' &&
      !resolvedAssetsUrl &&
      process.env?.GUREN_DEV_VITE !== '0'

    // Wires a managed Vite dev server into this listen() call — instance
    // field, active-server global, published env vars, entry sync, teardown —
    // identically for a freshly started server and one adopted from a
    // previous hot-reload run.
    const adoptViteDevServer = (viteServer: ViteServer, localUrl: string): void => {
      this.viteDevServer = viteServer
      setActiveViteDevServer(viteServer, localUrl)
      resolvedAssetsUrl = localUrl
      if (typeof process !== 'undefined') {
        process.env.VITE_DEV_SERVER_URL = localUrl
        process.env[MANAGED_VITE_ENV_FLAG] = '1'
      }
      syncManagedInertiaDevEntry(localUrl)
      this.registerViteTeardown()
    }

    // On a hot reload, adopt the previous run's Vite dev server instead of
    // restarting it: the browser keeps its HMR socket, and the reload skips
    // the `close()` wait entirely.
    const reusableVite = shouldStartVite ? reusableActiveViteDevServer(vite) : undefined

    // Only this call's Vite server is ours to close if the bind fails below.
    let startedViteHere = false

    if (reusableVite) {
      adoptViteDevServer(reusableVite.server, reusableVite.localUrl)
    } else {
      await stopActiveViteDevServer()
    }

    if (shouldStartVite && !reusableVite) {
      const viteOptions: StartViteDevServerOptions | undefined =
        typeof vite === 'object' ? vite : undefined

      try {
        await this.closeViteDevServer()
        const { server, localUrl } = await startViteDevServer({
          root: viteOptions?.root ?? process.cwd(),
          config: viteOptions?.config,
          host: viteOptions?.host,
          port: viteOptions?.port,
        })
        adoptViteDevServer(server, localUrl)
        startedViteHere = true
      } catch (error) {
        console.error('Failed to start Vite dev server:', error)
        process.exit(1)
      }
    }

    const attempts = resolvePortAttempts(portFallback, port)
    let server: BunServer | undefined
    let attemptPort = port

    for (let offset = 0; offset < attempts; offset += 1) {
      attemptPort = port + offset

      try {
        server = Bun.serve({
          port: attemptPort,
          hostname,
          // `{ server }` is Bun's convention for reaching the live server from a
          // handler; middleware reads `ctx.env.server.requestIP()` through it to
          // learn the socket peer (the MCP access guard, the rate limiter).
          fetch: (request: Request, server: BunServer) => this.fetch(request, { server }),
        })
        break
      } catch (error) {
        if (offset === attempts - 1 || !isAddressInUse(error)) {
          // Vite was started above, before anything tried to bind. Letting the
          // throw escape past it strands an asset server and its published env
          // vars in a process that has no application server — visible to any
          // caller that handles the rejection instead of exiting, which is
          // exactly what `GUREN_STRICT_PORT=1` invites callers to do.
          if (startedViteHere) {
            await this.closeViteDevServer()
          }

          throw error
        }

        console.warn(`[guren] Port ${attemptPort} is in use, trying ${attemptPort + 1}...`)
      }
    }

    if (!server) {
      throw new Error('Bun.serve did not return a server instance')
    }

    // Prefer what the runtime reports; `attemptPort` is the honest fallback,
    // because `Bun.serve` returned for exactly that port — unlike the
    // *requested* port, which a walk has already made wrong.
    //
    // `port: 0` is the one case with no fallback: the OS chose, and a stub
    // that reports nothing leaves the answer genuinely unknowable. Everything
    // else degrades rather than turning a reporting gap into an outage, since
    // the socket is already open by this point.
    let boundPort = server.port
    if (typeof boundPort !== 'number') {
      if (port === 0) {
        // Nothing has registered this socket's teardown yet, so close it here
        // rather than leaking it for the process lifetime.
        await server.stop?.(true)
        throw new Error(
          'Bun.serve did not report a bound port for `port: 0`. Application.listen cannot report the address it is serving on.',
        )
      }

      boundPort = attemptPort
    }

    const boundHostname = server.hostname ?? hostname
    const address: ListenAddress = {
      port: boundPort,
      hostname: boundHostname,
      url: toConnectableUrl(boundHostname, boundPort),
    }

    this.bunServer = server
    this.boundAddress = address
    setActiveBunServer(server)
    this.registerBunTeardown()

    const shouldLogBanner =
      typeof process === 'undefined' ||
      (process.env.NODE_ENV !== 'production' && process.env?.GUREN_DEV_BANNER !== '0')

    if (shouldLogBanner) {
      this.logDevServerBanner({
        hostname: boundHostname,
        port: boundPort,
        assetsUrl: resolvedAssetsUrl ?? 'http://localhost:5173',
      })
    }

    return address
  }

  /**
   * The address {@link Application.listen} bound, or `undefined` before it has
   * been called and once this app's server has been superseded or torn down.
   *
   * The same object `listen()` returned, so callers that need the address
   * later — an OpenAPI `servers` entry, an absolute URL, a health report —
   * read it here instead of threading it out of the entrypoint.
   *
   * The stored value is preferred over re-reading the live server, because
   * `listen()` resolves the port through a fallback the socket no longer
   * carries.
   *
   * Liveness is only as good as the signal available: a server stopped through
   * the framework — a later `listen()`, the process-exit teardown — clears the
   * slot this reads, but one stopped by calling `stop()` on the Bun server
   * directly does not, and this keeps reporting its address. Treat it as
   * "where `listen()` put this app", not as a health check.
   */
  get address(): ListenAddress | undefined {
    // The `bunServer` half is for the app that never listened: without it, two
    // `undefined`s would compare equal. Past that, a server this instance
    // started counts as ours only while it is still the active one, which is
    // false after a teardown and after the next `listen()` — including when
    // the rebind that follows it fails.
    if (!this.bunServer || getGlobalState().__gurenActiveServer !== this.bunServer) {
      return undefined
    }

    return this.boundAddress
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
      await closeViteDevServerBounded(this.viteDevServer)
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
