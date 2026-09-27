import type { Application, ApplicationListenOptions } from './Application'
import type { startViteDevServer } from './vite-dev-server'

export type BunServer = {
  stop?: (closeConnections?: boolean) => void | Promise<void>
  requestIP?: (request: Request) => { address?: string } | null
  port?: number
  hostname?: string
}
export type ViteServer = Awaited<ReturnType<typeof startViteDevServer>>['server']
export const MANAGED_VITE_ENV_FLAG = 'GUREN_MANAGED_VITE_DEV_SERVER'
const DEFAULT_DEV_ENTRY_PATH = '/resources/js/dev-entry.ts'

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

export function getGlobalState(): GurenGlobal {
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
 * How long a `bun --hot` reload waits on the server it replaces. That stop is
 * forced, and the hot-reload teardown has already server-closed every broadcast
 * WebSocket, so nothing is draining; on Bun 1.3.x `stop()` then never resolves
 * (1.4.0 resolves at once). Quoted in docs/{en,ja}/guides/architecture.md.
 */
const HOT_RELOAD_STOP_TIMEOUT_MS = 250

/** The bound on one server `stop()`, and whether hitting it is reported. */
interface StopBound {
  timeoutMs: number
  warn: boolean
}

function defaultStopBound(): StopBound {
  return { timeoutMs: bunStopTimeoutMs(), warn: true }
}

/**
 * Silent: on Bun 1.3.x it is hit on every reload, and there is nothing to
 * report. `GUREN_BUN_STOP_TIMEOUT_MS` can only shorten it: it is set for a
 * production drain, which a reload never is.
 */
export function hotReloadStopBound(): StopBound {
  return { timeoutMs: Math.min(bunStopTimeoutMs(), HOT_RELOAD_STOP_TIMEOUT_MS), warn: false }
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

/** `stop()` bounded by `bound` ({@link bunStopTimeoutMs} by default), warning rather than throwing. */
export async function stopBunServerBounded(
  server: BunServer,
  closeActiveConnections: boolean,
  bound: StopBound = defaultStopBound(),
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

  await awaitBounded(stopped, bound.timeoutMs, (timeoutMs) => {
    if (!bound.warn) return
    console.warn(
      `Bun server did not stop within ${timeoutMs}ms — no longer waiting on it. In-flight requests may still be draining.`,
    )
  })
}

export async function stopActiveBunServer(
  closeActiveConnections = false,
  bound?: StopBound,
): Promise<void> {
  const state = getGlobalState()
  const previous = state.__gurenActiveServer

  if (!previous?.stop) {
    state.__gurenActiveServer = undefined
    return
  }

  try {
    await stopBunServerBounded(previous, closeActiveConnections, bound)
  } finally {
    releaseActiveBunServer(previous)
  }
}

export function setActiveBunServer(server?: BunServer): void {
  getGlobalState().__gurenActiveServer = server
}

/**
 * Gives up the process-wide slot, but only while it still holds `server`: a
 * `listen()` that completed inside the caller's await has repointed it at a
 * live server, which clearing would strip of its exit teardown.
 */
export function releaseActiveBunServer(server: BunServer): void {
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
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    process.off('exit', onExit)
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
export async function closeViteDevServerBounded(server: ViteServer): Promise<void> {
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
export async function stopActiveViteDevServer(): Promise<void> {
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
export function reusableActiveViteDevServer(
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

/**
 * Closes the managed Vite dev server, but only while this application still
 * owns it: another `listen()` may have adopted the same object, and closing it
 * then would take the asset server out from under an app serving from it. The
 * slot's record is the one place that distinction exists.
 */
export async function closeOwnedViteDevServer(owner: Application): Promise<void> {
  const active = getGlobalState().__gurenActiveViteDevServer

  if (active?.owner !== owner) {
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

function registerViteTeardown(owner: Application): () => void {
  if (typeof process === 'undefined') {
    return () => {}
  }

  return registerProcessTeardown(
    () => {
      closeOwnedViteDevServer(owner)
        .then(() => process.exit(0))
        .catch(() => process.exit(1))
    },
    () => {
      const active = getGlobalState().__gurenActiveViteDevServer

      if (active?.owner === owner) {
        void active.server.close()
      }
    },
  )
}

export function registerBunTeardown(): () => void {
  if (typeof process === 'undefined') {
    return () => {}
  }

  // Both handlers read the global slot rather than capturing `server`, so one
  // registration keeps tearing down whatever the latest `listen()` bound.
  return registerProcessTeardown(
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

// Wires a Vite dev server into this listen() call identically whether it was
// freshly started or adopted. Taking ownership releases whoever held it
// before: two applications believing they may close one server means the
// first to stop takes the asset server out from under the other.
export function adoptViteDevServer(owner: Application, viteServer: ViteServer, localUrl: string): void {
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
    owner,
    disposeTeardown: registerViteTeardown(owner),
  })
}

