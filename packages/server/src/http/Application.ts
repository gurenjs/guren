import { Hono } from 'hono'
import type { MiddlewareHandler, ExecutionContext } from 'hono'
import { Router } from '../mvc/Router'
import { Container, mountModuleRoutes, setContainer, type ServiceProvider, type GurenModule } from '../container'
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
 * Opt-in strict port binding. The env var can only *subtract* the port walk,
 * never switch it on, so an operator can pin a port from outside an app whose
 * entrypoint they cannot edit — a smoke script, a Playwright `webServer`, CI.
 */
const STRICT_PORT_ENV_FLAG = 'GUREN_STRICT_PORT'

/**
 * The requested port plus 19 more. Counts *attempts*, not offsets, to match the
 * loop in the starter templates one-for-one.
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
 * How many ports `listen()` may try, counting the requested one. `PORT=0` never
 * walks: the OS already picked a free port, and walking would march into the
 * privileged 1, 2, 3.
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

  // Unset: walk in development, fail fast in production. No optional chain, so
  // the deploy plugins' `--define` can settle it at bundle time.
  return typeof process !== 'undefined' && process.env.NODE_ENV === 'production'
    ? 1
    : DEFAULT_PORT_WALK_ATTEMPTS
}

/**
 * A wildcard bind is reached through a loopback address of the same family.
 * Not `localhost`: it resolves to whichever family the host prefers, so an
 * IPv4-only `0.0.0.0` bind could hand back a URL a client tries over `::1`.
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
    // Only the entry this module published: `syncManagedInertiaDevEntry` leaves
    // a custom one alone, so the same test has to gate the removal.
    if (process.env.GUREN_INERTIA_ENTRY?.endsWith(DEFAULT_DEV_ENTRY_PATH)) {
      delete process.env.GUREN_INERTIA_ENTRY
    }
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

/**
 * The one managed Vite dev server this process runs, and who owns it. A server
 * outlives the `listen()` that started it — a `bun --hot` reload adopts it, so
 * two applications hold the same object and instance identity cannot tell them
 * apart. The slot names exactly one owner at a time instead.
 */
export interface ActiveViteDevServer {
  readonly server: ViteServer
  readonly localUrl: string
  readonly owner: Application
  /**
   * Detaches the owner's process teardown handlers. Whoever replaces this record
   * calls it: the outgoing owner is only reachable from here, and handlers left
   * attached would still close this server on the next signal.
   */
  readonly disposeTeardown: () => void
}

/**
 * The ambient slots `listen()` plants on `globalThis`, which a `bun --hot`
 * reload keeps, so the next run can find what the previous one left running.
 * Exported for the tests that plant stand-ins; not part of the public API.
 */
export interface GurenGlobalSlots {
  __gurenActiveServer?: BunServer
  __gurenActiveViteDevServer?: ActiveViteDevServer
}

type GurenGlobal = typeof globalThis & GurenGlobalSlots

function getGlobalState(): GurenGlobal {
  return globalThis as GurenGlobal
}

/**
 * How long a server `stop()` may take before shutdown stops waiting. Abandoning
 * this wait is safe in a way abandoning a Vite close is not: the socket has
 * already stopped accepting connections, so what is left is a drain.
 */
function bunStopTimeoutMs(): number {
  return shutdownTimeoutMs('GUREN_BUN_STOP_TIMEOUT_MS')
}

/**
 * A positive integer of milliseconds, or 5000 when unset or unparseable. One
 * parse for both bounds, so they cannot drift apart.
 */
function shutdownTimeoutMs(envName: string): number {
  const parsed =
    typeof process !== 'undefined' ? Number.parseInt(process.env[envName] ?? '', 10) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5000
}

/**
 * Awaits `work`, giving up after `timeoutMs`. Resolves either way: every caller
 * is a shutdown path, and one that hangs is worse than one that gives up.
 */
async function awaitBounded(
  work: Promise<unknown>,
  timeoutMs: number,
  onTimeout: (timeoutMs: number) => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const timedOut = await Promise.race([
      work.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs)
      }),
    ])

    if (timedOut) {
      onTimeout(timeoutMs)
    }
  } finally {
    clearTimeout(timer)
  }
}

/** `stop()` bounded by {@link bunStopTimeoutMs}, warning rather than throwing. */
async function stopBunServerBounded(
  server: BunServer,
  closeActiveConnections: boolean,
): Promise<void> {
  // An async IIFE, not `Promise.resolve(...).catch(...)`: a `stop` that throws
  // synchronously would escape that catch and reject the whole shutdown path.
  const stopped = (async () => {
    try {
      await server.stop?.(closeActiveConnections)
    } catch (error) {
      console.warn('Failed to stop Bun server:', error)
    }
  })()

  await awaitBounded(stopped, bunStopTimeoutMs(), (timeoutMs) => {
    console.warn(
      `Bun server did not stop within ${timeoutMs}ms — no longer waiting on it. In-flight requests may still be draining.`,
    )
  })
}

async function stopActiveBunServer(closeActiveConnections = false): Promise<void> {
  const state = getGlobalState()
  const previous = state.__gurenActiveServer

  if (!previous?.stop) {
    state.__gurenActiveServer = undefined
    return
  }

  try {
    await stopBunServerBounded(previous, closeActiveConnections)
  } finally {
    releaseActiveBunServer(previous)
  }
}

function setActiveBunServer(server?: BunServer): void {
  getGlobalState().__gurenActiveServer = server
}

/**
 * Gives up the process-wide slot, but only while it still holds `server`: a
 * `listen()` that completed inside the caller's await has repointed it at a
 * live server, which clearing would strip of its exit teardown.
 */
function releaseActiveBunServer(server: BunServer): void {
  if (getGlobalState().__gurenActiveServer === server) {
    setActiveBunServer()
  }
}

/**
 * Attaches one SIGINT/SIGTERM/exit trio and returns the disposer for it. A
 * boolean-guarded registrar would leave handlers attached and let the next
 * `listen()` stack a second set on top — and `process.once` fires in
 * registration order, so a stale handler's `process.exit()` can end the process
 * ahead of the live set's shutdown.
 */
function registerProcessTeardown(onSignal: () => void, onExit: () => void): () => void {
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  process.on('exit', onExit)

  return () => {
    // Via the EventEmitter surface: bun-types 1.4.0 declares `off` on Process
    // with only a "memoryPressure" overload, shadowing the generic `off`, so
    // signal names stop compiling. `on`/`once` are unaffected.
    const emitter: NodeJS.EventEmitter = process
    emitter.off('SIGINT', onSignal)
    emitter.off('SIGTERM', onSignal)
    emitter.off('exit', onExit)
  }
}

/**
 * How long a Vite `close()` may take before shutdown abandons it — a browser tab
 * holding its HMR socket can keep that wait alive indefinitely. A stranded asset
 * server is recoverable noise; a `listen()` that never returns is not.
 */
function viteCloseTimeoutMs(): number {
  return shutdownTimeoutMs('GUREN_VITE_CLOSE_TIMEOUT_MS')
}

/**
 * `close()` bounded by {@link viteCloseTimeoutMs}: resolves once the server
 * closed, failed (warned), or ran out the clock (warned, abandoned).
 */
async function closeViteDevServerBounded(server: ViteServer): Promise<void> {
  const close = (async () => {
    try {
      await server.close()
    } catch (error) {
      console.warn('Failed to stop Vite dev server:', error)
    }
  })()

  await awaitBounded(close, viteCloseTimeoutMs(), (timeoutMs) => {
    console.warn(
      `Vite dev server did not close within ${timeoutMs}ms — abandoning it. A stale asset server may still hold its port.`,
    )
  })
}

/**
 * Closes the managed Vite dev server whoever owns it. Only `listen()`'s restart
 * path calls this — the one case where an owner's claim does not survive.
 */
async function stopActiveViteDevServer(): Promise<void> {
  const previous = getGlobalState().__gurenActiveViteDevServer

  try {
    if (previous) {
      await closeViteDevServerBounded(previous.server)
    }
  } finally {
    previous?.disposeTeardown()
    // Only while the slot still holds the record this call retired: a `listen()`
    // elsewhere may have installed a live one while the close was awaited.
    if (getGlobalState().__gurenActiveViteDevServer === previous) {
      setActiveViteDevServer()
    }
  }
}

function publishManagedViteEnv(localUrl: string): void {
  if (typeof process === 'undefined') {
    return
  }

  process.env.VITE_DEV_SERVER_URL = localUrl
  process.env[MANAGED_VITE_ENV_FLAG] = '1'
  syncManagedInertiaDevEntry(localUrl)
}

/**
 * The one write point for the active-record slot. `VITE_DEV_SERVER_URL` and the
 * managed flag travel with it, so a stale close cannot unpublish an adopter's
 * URL while its record stays live, or the reverse.
 */
function setActiveViteDevServer(active?: ActiveViteDevServer): void {
  getGlobalState().__gurenActiveViteDevServer = active

  if (active) {
    publishManagedViteEnv(active.localUrl)
  } else {
    clearManagedViteEnv()
  }
}

/**
 * The managed Vite dev server a previous `listen()` left running. Reusing it
 * keeps the browser's HMR socket connected and skips the
 * {@link viteCloseTimeoutMs} wait. Explicit `vite` options veto reuse: the
 * running server was built from the *previous* call's options.
 */
function reusableActiveViteDevServer(
  viteOption: ApplicationListenOptions['vite'],
): ActiveViteDevServer | undefined {
  if (typeof viteOption === 'object') {
    return undefined
  }

  const active = getGlobalState().__gurenActiveViteDevServer

  if (!active || !active.server.httpServer?.listening) {
    return undefined
  }

  return active
}

export type BootCallback = (app: Hono) => void | Promise<void>

export type { ServiceProviderConstructor } from '../container/ServiceProvider'
export type RouteRegistration = (router: Router) => void | Promise<void>
export type ApplicationFeatures = Record<string, unknown>

export interface ApplicationOptions {
  readonly boot?: BootCallback
  readonly providers?: Array<ServiceProviderConstructor>
  readonly auth?: AuthPluginOptions
  /** When set, {@link I18nServiceProvider} is registered automatically. */
  readonly i18n?: I18nPluginOptions
  readonly routes?: RouteRegistration
  /**
   * Application modules (RFC 0002). Their providers are appended to `providers`
   * and their route registrars run after `routes`, under the module's prefix.
   */
  readonly modules?: GurenModule[]
  readonly features?: ApplicationFeatures
  /** Enabled by default with Rails-matching defaults; `false` disables it. */
  readonly securityHeaders?: SecurityHeadersOptions | false
  /** DNS rebinding protection. Off unless configured; the template configures it. */
  readonly hostAuthorization?: HostAuthorizationOptions | false
}

export interface I18nPluginOptions {
  /** Detection only resolves to one of these; all are preloaded during `boot()`. */
  readonly supported: readonly string[]
  /** Defaults to the first supported locale. */
  readonly fallback?: string
  /**
   * Directory of `<path>/<locale>/*.json` files. Defaults to `'lang'`; ignored
   * when `loader` is set. Framework tooling (typed keys, `check --i18n`, the
   * Vite watch) assumes `lang/`, so a custom path or loader opts out of it.
   */
  readonly path?: string
  /** Takes precedence over `path` — e.g. `MemoryLoader` on a filesystem-less target. */
  readonly loader?: TranslationLoader
  /** `detectLocaleMiddleware` is mounted automatically; `false` to do it yourself. */
  readonly detect?: Omit<DetectLocaleOptions, 'supported' | 'fallback' | 'i18n'> | false
  /** Share the locale and its messages with Inertia as `_i18n`. Defaults to `true`. */
  readonly share?: boolean
}

export interface AuthPluginOptions {
  autoSession?: boolean
  sessionOptions?: CreateSessionMiddlewareOptions
  /** Defaults to `true` when session is enabled. */
  autoCsrf?: boolean
  csrfOptions?: import('./middleware/csrf').CsrfOptions
}

export interface ApplicationListenOptions {
  port?: number
  hostname?: string
  assetsUrl?: string
  vite?: StartViteDevServerOptions | false
  /**
   * `true` walks forward through the next 20 ports, `false` fails fast on
   * EADDRINUSE, unset walks outside production. `GUREN_STRICT_PORT=1` forces
   * fail-fast regardless, and `port: 0` never walks.
   */
  portFallback?: boolean
}

/**
 * Where the server actually ended up listening — with a port walk or `PORT=0`
 * in play, not the port that was asked for. Read-only because
 * {@link Application.address} hands back this very object.
 */
export interface ListenAddress {
  /** What the runtime reports, falling back to the port `Bun.serve` succeeded on. */
  readonly port: number
  readonly hostname: string
  /** A URL that reaches the server, with a wildcard bind resolved to localhost. */
  readonly url: string
}

/**
 * Wires an app-local router and a DI container into a running Hono instance.
 *
 * Lifecycle rule for `listen()`/`stop()` and their helpers: re-check ownership
 * after every `await`. A concurrent call may have superseded any server or slot
 * they remembered, and only the current owner may clear shared state.
 */
export class Application {
  readonly hono: Hono
  readonly container: Container
  readonly router: Router
  private readonly providerManager: ProviderManager
  private readonly authManager: AuthManager
  private bunServer?: BunServer
  private boundAddress?: ListenAddress
  /**
   * Detaches the Bun half's process teardown handlers, and doubles as the "are
   * they attached?" memo — one field, because a memo and an undo that disagree
   * leave handlers attached while a flag says otherwise. The Vite half's
   * disposer lives in {@link ActiveViteDevServer}, since adoption moves that
   * server to an owner reachable only through the slot.
   */
  private disposeBunTeardown?: () => void
  private autoSessionAttached = false
  private routesRegistered = false
  private bootPromise?: Promise<void>

  constructor(private readonly options: ApplicationOptions = {}) {
    this.hono = new Hono()
    this.container = new Container()
    this.router = new Router()
    this.authManager = new AuthManager()
    this.providerManager = new ProviderManager(this.container)

    // Not in boot(): Hono composes matched handlers in registration order, and
    // the scaffolded templates register asset routes at module scope, before
    // boot() runs. Registering first here is the one ordering an app cannot
    // get in front of.
    this.mountSecurityDefaults()

    this.container.instance('app', this as Application)
    this.container.instance('hono', this.hono)
    this.container.instance('auth', this.authManager)
    this.container.instance('router', this.router)

    // So requireAuthenticated/requireGuest work for apps that wire sessions
    // manually, without the auth option.
    if (!this.authManager.guardNames().length) {
      this.authManager.registerGuard('web', ({ session, manager }) => {
        // Without a 'users' provider this guard always answers unauthenticated.
        let provider: any
        try { provider = manager.getProvider('users') } catch {
          provider = { retrieveById: async () => null, retrieveByCredentials: async () => null, validateCredentials: async () => false }
        }
        return new SessionGuard({ provider, session })
      })
      this.authManager.setDefaultGuard('web')
    }

    // The fallback is attached in the constructor so middleware registered via
    // app.use() before boot() finds it. The context resolves its session
    // lazily, so running ahead of the session middleware is fine.
    if (this.options.auth) {
      this.providerManager.register(AuthServiceProvider)
    } else {
      this.hono.use('*', attachAuthContext((ctx) => this.authManager.createAuthContext(ctx)))
    }

    this.providerManager.register(AuthorizationServiceProvider)

    // Through the same registerMany() as options.providers, so a module-supplied
    // Error/Inertia provider subclass overrides the default like a top-level one.
    const moduleProviders = (this.options.modules ?? []).flatMap((module) => module.providers)
    const userProviders = [
      ...(Array.isArray(this.options.providers) ? this.options.providers : []),
      ...moduleProviders,
    ]

    // A user-supplied subclass of a default provider takes ownership of that
    // subsystem's wiring, so the default registration below is skipped.
    const hasUserProviderOf = (base: ServiceProviderConstructor): boolean =>
      userProviders.some((provider) => provider === base || provider.prototype instanceof base)

    if (this.options.i18n && !hasUserProviderOf(I18nServiceProvider)) {
      this.providerManager.register(I18nServiceProvider)
    }

    // Before user providers, so a custom ErrorServiceProvider subclass wins via
    // its later hono.onError() call.
    if (!hasUserProviderOf(ErrorServiceProvider)) {
      this.providerManager.register(ErrorServiceProvider)
    }

    if (userProviders.length > 0) {
      this.providerManager.registerMany(userProviders)
    }

    // After user providers: the first matching exception renderer wins, so a
    // user-registered ValidationException renderer keeps precedence over this.
    if (!hasUserProviderOf(InertiaServiceProvider)) {
      this.providerManager.register(InertiaServiceProvider)
    }

    // Publish as the process-wide container: code outside a request (Job.make(),
    // the exported resolve()) reaches it only through the global. In the
    // constructor, because `guren queue:work` and a job dispatched at module
    // scope never boot the app. Last statement, so a constructor that throws
    // leaves the previous container in place rather than a half-built one.
    setContainer(this.container)
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

  async mountRoutes(): Promise<void> {
    if (!this.routesRegistered) {
      if (this.options.routes) {
        // Not cleared: routes added directly to app.router before boot() stay.
        await this.options.routes(this.router)
      }

      for (const gurenModule of this.options.modules ?? []) {
        await mountModuleRoutes(this.router, gurenModule)
      }

      this.routesRegistered = true
    }

    this.router.mount(this.hono, { container: this.container })
  }

  use(path: string, ...middleware: MiddlewareHandler[]): void {
    this.hono.use(path, ...middleware)
  }

  /**
   * Registers providers, runs the boot callback, mounts routes, boots providers.
   *
   * Booting twice is a no-op — the first call's promise is reused, concurrent
   * callers included. A boot that throws is not remembered, so a later call
   * retries on the partially mounted app rather than starting clean.
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

  /** Called once, from the constructor — see the note there for why. */
  private mountSecurityDefaults(): void {
    const { securityHeaders } = this.options
    if (securityHeaders !== false) {
      this.hono.use('*', createSecurityHeaders(securityHeaders ?? {}))
    }

    this.mountHostAuthorization()
  }

  private mountHostAuthorization(): void {
    const { hostAuthorization } = this.options

    if (hostAuthorization === false || !hostAuthorization) return

    this.hono.use('*', createHostAuthorizationMiddleware(hostAuthorization))
  }

  /**
   * Mounts an opt-in, dev-only framework endpoint. Only the dynamic import may
   * fail silently — these providers reach optional dependencies an app need not
   * have installed. A failure inside the provider's own boot is rethrown.
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

    await provider.register?.()
    await provider.boot?.()
  }

  async fetch(request: Request, env?: unknown, executionCtx?: ExecutionContext): Promise<Response> {
    return this.hono.fetch(request, env, executionCtx)
  }

  async listen(options: ApplicationListenOptions = {}): Promise<ListenAddress> {
    if (!Bun) {
      throw new Error('Bun runtime is required to call Application.listen')
    }

    // Force-close: this only runs when a `bun --hot` reload replaces a previous
    // `listen()`, which must not wait on the old server's in-flight requests.
    // The retired server is remembered so the check below can tell "already
    // stopped here" from "bound by a concurrent call".
    const supersededServer = getGlobalState().__gurenActiveServer
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

    // Wires a Vite dev server into this listen() call identically whether it was
    // freshly started or adopted. Taking ownership releases whoever held it
    // before: two applications believing they may close one server means the
    // first to stop takes the asset server out from under the other.
    const adoptViteDevServer = (viteServer: ViteServer, localUrl: string): void => {
      const displaced = getGlobalState().__gurenActiveViteDevServer
      displaced?.disposeTeardown()

      // Adoption re-installs the record around the same server; anything else
      // is a concurrent listen()'s, which dropping would strand on its port.
      if (displaced && displaced.server !== viteServer) {
        void closeViteDevServerBounded(displaced.server)
      }

      setActiveViteDevServer({
        server: viteServer,
        localUrl,
        owner: this,
        disposeTeardown: this.registerViteTeardown(),
      })

      resolvedAssetsUrl = localUrl
    }

    // Adopting keeps the browser's HMR socket and skips the `close()` wait.
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
          // Bun's convention for reaching the live server from a handler:
          // middleware reads `ctx.env.server.requestIP()` for the socket peer.
          fetch: (request: Request, server: BunServer) => this.fetch(request, { server }),
        })
        break
      } catch (error) {
        if (offset === attempts - 1 || !isAddressInUse(error)) {
          // Vite started before anything tried to bind; letting the throw
          // escape past it would strand an asset server, and its published env
          // vars, in a process with no application server.
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
    // since `Bun.serve` returned for exactly that port — unlike the *requested*
    // one, which a walk has already made wrong. `port: 0` has no fallback: the
    // OS chose, so a runtime that reports nothing makes the answer unknowable.
    let boundPort = server.port
    if (typeof boundPort !== 'number') {
      if (port === 0) {
        // No teardown is registered for this socket yet, so close it here.
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

    // A concurrent listen() may have bound its own server while this call
    // awaited. Nothing has closed it, so overwriting the handle below would
    // leave that socket live with no way to reach it.
    const displaced = this.bunServer
    if (displaced && displaced !== server && displaced !== supersededServer) {
      await stopBunServerBounded(displaced, true)
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
   * The address {@link Application.listen} bound — the same object it returned,
   * preferred over re-reading the live server, whose port `listen()` may have
   * resolved through a fallback the socket itself does not carry. Only stops
   * that go through the framework clear it, so treat it as "where `listen()`
   * put this app", not as a health check.
   */
  get address(): ListenAddress | undefined {
    // Both halves earn their place: without `bunServer` two `undefined`s would
    // compare equal, and `stop()` reaches only the instance while a supersede or
    // exit teardown reaches only the slot.
    if (!this.bunServer || getGlobalState().__gurenActiveServer !== this.bunServer) {
      return undefined
    }

    return this.boundAddress
  }

  /**
   * Stops the server {@link listen} started; a no-op when nothing is listening
   * or when called twice. `closeActiveConnections` forces in-flight requests
   * closed, matching Bun's own `stop()`. The managed Vite dev server goes too,
   * unless a later `listen()` adopted it. Both closes are bounded
   * ({@link bunStopTimeoutMs}, {@link viteCloseTimeoutMs}) and then abandoned.
   */
  async stop(closeActiveConnections = false): Promise<void> {
    const server = this.bunServer

    if (server) {
      try {
        await stopBunServerBounded(server, closeActiveConnections)
      } finally {
        // `closeViteDevServer()` guards the Vite slot the same way.
        releaseActiveBunServer(server)
      }
    }

    // A `listen()` that ran inside the await above already took these fields
    // over; everything below would undo that call rather than this one.
    if (this.bunServer !== server) {
      return
    }

    this.bunServer = undefined
    this.boundAddress = undefined

    // Detached rather than forgotten: a later `listen()` re-attaches, which is
    // what keeps a restarted app reachable by SIGINT/SIGTERM.
    this.disposeBunTeardown?.()
    this.disposeBunTeardown = undefined

    await this.closeViteDevServer()
  }

  register(provider: ServiceProviderConstructor): this {
    this.providerManager.register(provider)
    return this
  }

  registerMany(providers: Array<ServiceProviderConstructor>): this {
    this.providerManager.registerMany(providers)
    return this
  }

  logDevServerBanner(options: DevBannerOptions): void {
    logDevServerBanner(options)
  }

  /**
   * Closes the managed Vite dev server, but only while this application still
   * owns it: another `listen()` may have adopted the same object, and closing it
   * then would take the asset server out from under an app serving from it. The
   * slot's record is the one place that distinction exists.
   */
  private async closeViteDevServer(): Promise<void> {
    const active = getGlobalState().__gurenActiveViteDevServer

    if (active?.owner !== this) {
      return
    }

    try {
      await closeViteDevServerBounded(active.server)
    } finally {
      active.disposeTeardown()
      // Skipped if an adoption happened while the close was awaited: the slot
      // describes the adopter's claim now, not this call's.
      if (getGlobalState().__gurenActiveViteDevServer === active) {
        setActiveViteDevServer()
      }
    }
  }

  /**
   * Attaches this application's Vite teardown handlers and returns the disposer.
   * It is stored in the active-record slot, not on this instance, because
   * whoever takes ownership next is the one that has to call it.
   */
  private registerViteTeardown(): () => void {
    if (typeof process === 'undefined') {
      return () => {}
    }

    return registerProcessTeardown(
      () => {
        this.closeViteDevServer()
          .then(() => process.exit(0))
          .catch(() => process.exit(1))
      },
      () => {
        const active = getGlobalState().__gurenActiveViteDevServer

        if (active?.owner === this) {
          void active.server.close()
        }
      },
    )
  }

  private registerBunTeardown(): void {
    if (this.disposeBunTeardown || typeof process === 'undefined') {
      return
    }

    // Both handlers read the global slot rather than capturing `server`, so one
    // registration keeps tearing down whatever the latest `listen()` bound.
    this.disposeBunTeardown = registerProcessTeardown(
      () => {
        stopActiveBunServer()
          .then(() => process.exit(0))
          .catch(() => process.exit(1))
      },
      () => {
        void stopActiveBunServer()
      },
    )
  }
}

export function createApp(options: ApplicationOptions = {}): Application {
  return new Application(options)
}

export type { Context } from 'hono'
