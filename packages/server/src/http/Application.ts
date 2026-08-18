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
    // Unpublish only the entry this module published. `syncManagedInertiaDevEntry`
    // leaves an app's custom entry alone, so the same test has to gate the
    // removal — otherwise stopping would delete a value nothing here set.
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
 * The one managed Vite dev server this process runs, and who owns it.
 *
 * The owner matters because a dev server outlives the `listen()` that started
 * it: on a `bun --hot` reload the next `listen()` adopts the running server
 * rather than restarting it, and both applications then hold the same object.
 * Instance identity cannot tell those two apart — it is the same server — so
 * "may I close this?" is answered here instead, by the slot naming exactly one
 * owner at a time.
 */
export interface ActiveViteDevServer {
  readonly server: ViteServer
  readonly localUrl: string
  readonly owner: Application
  /**
   * Detaches the owner's process teardown handlers. Whoever replaces this
   * record calls it, because the outgoing owner is only reachable from here —
   * and a set of handlers left attached would still close this server, and run
   * its own `process.exit()`, on the next signal.
   */
  readonly disposeTeardown: () => void
}

/**
 * The ambient slots `listen()` plants on `globalThis` so a `bun --hot` reload,
 * which re-runs the entrypoint but keeps `globalThis`, can find what the
 * previous run left running.
 *
 * Exported so the tests that plant stand-ins in these slots can name them
 * against this declaration instead of restating it. Not part of the public
 * API: `src/index.ts` re-exports by name and does not list it.
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
 * How long a server `stop()` may take before shutdown stops waiting on it.
 * A graceful stop waits for every in-flight request, and one that never
 * completes would otherwise hold a shutdown open forever. Abandoning the wait
 * is safe in a way abandoning a Vite close is not: the socket has already
 * stopped accepting connections by the time `stop()` returns its promise, so
 * what is left running is a drain, not a listener.
 */
function bunStopTimeoutMs(): number {
  return shutdownTimeoutMs('GUREN_BUN_STOP_TIMEOUT_MS')
}

/**
 * A shutdown bound read from the environment: a positive integer number of
 * milliseconds, or 5 seconds when the variable is unset or unparseable. One
 * parse for both bounds, so the contract cannot drift between them.
 */
function shutdownTimeoutMs(envName: string): number {
  const parsed =
    typeof process !== 'undefined' ? Number.parseInt(process.env[envName] ?? '', 10) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5000
}

/**
 * Awaits `work`, giving up after `timeoutMs` and reporting through `onTimeout`.
 * Resolves either way — every caller is a shutdown path, and a shutdown that
 * hangs is worse than one that abandons what it was waiting for.
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

/**
 * `stop()` bounded by {@link bunStopTimeoutMs}, warning rather than throwing:
 * a caller shutting down cannot do anything useful with the failure, and every
 * caller here goes on to give up its handle on the server either way.
 */
async function stopBunServerBounded(
  server: BunServer,
  closeActiveConnections: boolean,
): Promise<void> {
  // An async IIFE rather than `Promise.resolve(server.stop(...)).catch(...)`:
  // a `stop` that throws synchronously would otherwise escape the catch and
  // reject the whole shutdown path instead of being warned about.
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
 * Give up the process-wide active-server slot, but only if it still holds
 * `server`. A `listen()` that ran to completion inside the caller's await has
 * already repointed the slot at a live server, and clearing then would strip
 * that server of the SIGINT/SIGTERM/exit teardown that reads it.
 */
function releaseActiveBunServer(server: BunServer): void {
  if (getGlobalState().__gurenActiveServer === server) {
    setActiveBunServer()
  }
}

/**
 * Attaches one SIGINT/SIGTERM/exit trio and returns the disposer that detaches
 * it again. Both teardown registrars go through here so neither can drift back
 * to the shape this replaces: a registrar guarded by a boolean that a close
 * merely flips back leaves its handlers attached, and the next `listen()` adds
 * a second set on top.
 *
 * The count is the lesser half of that. `process.once` fires handlers in
 * registration order, and a stale set's signal handler still runs its own
 * `process.exit()` — so it can end the process ahead of the live set's
 * shutdown, which is the one thing the teardown exists to complete.
 */
function registerProcessTeardown(onSignal: () => void, onExit: () => void): () => void {
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  process.on('exit', onExit)

  return () => {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    process.off('exit', onExit)
  }
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
  return shutdownTimeoutMs('GUREN_VITE_CLOSE_TIMEOUT_MS')
}

/**
 * `close()` bounded by {@link viteCloseTimeoutMs}: resolves once the server
 * closed, failed to close (warned), or ran out the clock (warned, abandoned).
 * Every shutdown path shares this — the exit handlers and the bind-failure
 * cleanup hang on a held HMR socket exactly like a hot reload does.
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
 * Closes whatever managed Vite dev server this process is running, whoever owns
 * it. Only `listen()`'s restart path calls this — it is deciding to replace the
 * running server outright, which is the one case where an owner's claim does
 * not survive.
 */
async function stopActiveViteDevServer(): Promise<void> {
  const previous = getGlobalState().__gurenActiveViteDevServer

  try {
    if (previous) {
      await closeViteDevServerBounded(previous.server)
    }
  } finally {
    previous?.disposeTeardown()
    // Only give up the slot if it still holds the record this call retired: a
    // `listen()` elsewhere can have installed a live record while the close
    // above was awaited, and clearing then would unpublish its env vars too.
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
 * The one write point for the active-record slot. The published env vars are
 * the record's outward face — `VITE_DEV_SERVER_URL` and the managed flag are
 * how the rest of the process learns which asset server is live — so they
 * travel with the slot: setting a record publishes its URL, clearing the slot
 * unpublishes. Keeping the two writes together is what stops a stale close
 * from unpublishing an adopter's URL while its record stays live, or the
 * reverse.
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
 * The managed Vite dev server a previous `listen()` left running in this same
 * process — `bun --hot` re-runs the entrypoint but preserves `globalThis`.
 * Reusing it keeps the browser's HMR socket connected and avoids the Vite
 * `close()` wait described on {@link viteCloseTimeoutMs}. Explicit `vite`
 * options veto reuse: the running server was built from the *previous* call's
 * options, and this call's may differ.
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
 *
 * Lifecycle rule for `listen()`/`stop()` and their helpers: re-check ownership
 * after every `await`. Any server or slot they remembered can have been
 * superseded by a concurrent call while they waited, and only the current
 * owner may clear shared state.
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
   * they attached?" memo. One field rather than a separate boolean: a memo and
   * an undo that can disagree is how handlers end up attached while a flag says
   * otherwise — see {@link registerProcessTeardown}.
   *
   * The Vite half's disposer lives in {@link ActiveViteDevServer} instead,
   * because the application that detaches those handlers is not always the one
   * that attached them: adoption moves the server to a new owner, and the
   * outgoing owner is only reachable through the slot.
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

    // Publish this container as the process-wide one. Code that runs outside a
    // request has no context to reach it through — Job.make() and the exported
    // resolve() both read the global — so without this every job that resolves
    // a service throws "Container not initialized".
    //
    // Construction rather than boot(): `guren queue:work` bootstraps the app
    // only far enough to read the queue driver, and an entry that just exports
    // the application (no `ready`/`bootstrap`) is accepted there and never
    // booted. A job dispatched from module scope is in the same position.
    //
    // Last statement of the constructor, so an application that fails to build
    // — provider registration below instantiates providers, and that can throw
    // — leaves the previous application's container in place rather than
    // publishing its own half-built one. Otherwise last construction wins,
    // which is what `bun --hot` wants: a reloaded entry replaces the stale
    // container instead of being ignored.
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
    // The server it retires is remembered so the displaced-handle check below
    // can tell "already stopped here" from "bound by a concurrent call".
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

    // Wires a managed Vite dev server into this listen() call — ownership,
    // instance field, published env vars, entry sync, teardown — identically
    // for a freshly started server and one adopted from a previous hot-reload
    // run.
    //
    // Taking ownership releases whoever held it before, so the server has
    // exactly one owner at every moment. Without that, an adopted server has
    // two applications believing they may close it, and the first of them to
    // stop takes the asset server out from under the one still serving.
    const adoptViteDevServer = (viteServer: ViteServer, localUrl: string): void => {
      const displaced = getGlobalState().__gurenActiveViteDevServer
      displaced?.disposeTeardown()

      // Adoption re-installs the record around the same server. Anything else
      // in the slot is a fresh server a concurrent listen() started, and
      // dropping its record without closing it would strand it on its port —
      // best-effort and unawaited on the same terms as every other close.
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

    // A concurrent listen() on this instance may have bound a server of its
    // own while this call was awaiting above. It is not the server this call
    // force-stopped on entry, so nothing has closed it — and overwriting the
    // handle below would leave that socket live with no way to reach it.
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
   * the framework — {@link Application.stop}, a later `listen()`, the
   * process-exit teardown — clears what this reads, but one stopped by reaching
   * past the framework to the Bun server's own `stop()` does not, and this keeps
   * reporting its address. Treat it as "where `listen()` put this app", not as a
   * health check.
   */
  get address(): ListenAddress | undefined {
    // The `bunServer` half is for the app that never listened: without it, two
    // `undefined`s would compare equal. It also covers `stop()`, which clears
    // both instance fields. Past that, a server this instance started counts as
    // ours only while it is still the active one, which is false after a
    // teardown and after the next `listen()` — including when the rebind that
    // follows it fails. Both halves earn their place: `stop()` reaches only the
    // instance, and a supersede or an exit teardown reaches only the slot.
    if (!this.bunServer || getGlobalState().__gurenActiveServer !== this.bunServer) {
      return undefined
    }

    return this.boundAddress
  }

  /**
   * Stops the server {@link listen} started, undoing that call.
   *
   * Safe to call when nothing is listening, and safe to call twice — both are
   * no-ops. A later `listen()` starts cleanly, so an app may be stopped and
   * restarted in one process.
   *
   * `closeActiveConnections` forces in-flight requests closed instead of
   * waiting for them, matching Bun's own `stop()` parameter. It defaults to
   * `false` (graceful) because a caller reaching for a public stop is usually
   * shutting down deliberately; the hot-reload path inside `listen()` forces
   * the close, since a reload must not wait on the server it is replacing.
   *
   * The managed Vite dev server is taken down too. `listen()` is what started
   * it, and `listen()`'s own bind-failure path already closes the one it
   * started — leaving it running here would strand an asset server, and its
   * published env vars, in a process with no application server. That close is
   * best-effort on the same terms as every other path: it is bounded by
   * {@link viteCloseTimeoutMs}, and a Vite server that overruns the bound is
   * warned about and abandoned rather than holding this call open. A dev server
   * a later `listen()` has adopted is left alone — it belongs to that call now.
   *
   * The stop itself is bounded by {@link bunStopTimeoutMs}: a graceful stop
   * waits on in-flight requests, and one that never finishes would otherwise
   * hold this call open forever.
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

    // A `listen()` that ran inside the await above has already bound a new
    // socket and taken these fields over. Everything below would undo that
    // call rather than this one: it would orphan the new server — live, with
    // no handle to stop it and no signal handlers — and close the Vite dev
    // server it just wired up.
    if (this.bunServer !== server) {
      return
    }

    this.bunServer = undefined
    this.boundAddress = undefined

    // Detach the process handlers rather than just forgetting them: a later
    // `listen()` re-attaches, and that is what keeps a restarted app reachable
    // by SIGINT/SIGTERM.
    this.disposeBunTeardown?.()
    this.disposeBunTeardown = undefined

    await this.closeViteDevServer()
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

  /**
   * Closes the managed Vite dev server, but only while this application still
   * owns it.
   *
   * Ownership is the whole check. A `listen()` elsewhere in the process may
   * have adopted the running server — same object, new owner — and closing it
   * then would take the asset server, and its published env vars, out from
   * under an application that is actively serving from it. The record in the
   * slot is the one place that distinction exists, so it is read here rather
   * than mirrored on the instance.
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
      // Skip the release if an adoption happened while the close above was
      // awaited: the slot — and the published env vars that travel with it —
      // describe the adopter's claim now, not this call's.
      if (getGlobalState().__gurenActiveViteDevServer === active) {
        setActiveViteDevServer()
      }
    }
  }

  /**
   * Attaches this application's Vite teardown handlers and returns the disposer
   * that detaches them. The disposer is stored in the active-record slot rather
   * than on this instance, because whoever takes ownership next is the one that
   * has to call it — and a disposer another app could spend would leave this
   * instance believing its handlers are attached when they are not.
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
