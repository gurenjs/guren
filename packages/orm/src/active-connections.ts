/**
 * Closes the database client a previous module evaluation left open.
 *
 * `bun --hot` re-runs the module graph inside the same process. The cached
 * client each `create*Database()` factory keeps in closure state is reset along
 * with the module, but the connection that client opened stays alive with
 * nothing left holding a reference that could close it — one leaked connection
 * per reload until the server refuses new ones.
 *
 * `globalThis` survives re-evaluation, so it is where the previous client's
 * teardown is parked — the same storage `Application.listen()` uses for the Bun
 * and Vite dev servers. Bun does not expose `import.meta.hot` to `bun --hot`
 * (checked on 1.3.14), so there is no reload hook to register with instead.
 *
 * Only the storage carries over from `Application.listen()`, though, not its
 * simplicity: a process has exactly one Bun server, so `listen()` can replace
 * whatever it finds unconditionally. Connections have no such guarantee — an
 * app may well open one pool for web requests and another for background jobs
 * against the same database — so a re-evaluated factory has to be told apart
 * from a second factory created deliberately alongside the first. Closing a
 * live handle would be a worse bug than the leak, so this only runs under
 * `--hot`, and only when the factory's own source location can be determined to
 * key it by. The one case that still collides is a loop opening the same
 * database from a single line more than once — a duplicate by construction; a
 * loop over per-tenant URLs is keyed apart by its target.
 */

type Teardown = () => Promise<void> | void

const REGISTRY_KEY = Symbol.for('guren.orm.activeConnections')

/**
 * How long to wait for the previous client to close before giving up on it.
 *
 * The teardown is awaited so the replacement never runs alongside the client it
 * replaces — that back-pressure is what keeps a burst of reloads from stacking
 * up connections. But it runs on the path to the first query after a reload, so
 * a client whose socket never finishes closing must not wedge the dev server.
 */
const TEARDOWN_TIMEOUT_MS = 5_000

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, Teardown>
}

function getRegistry(): Map<string, Teardown> {
  const scope = globalThis as GlobalWithRegistry
  const existing = scope[REGISTRY_KEY]

  if (existing) {
    return existing
  }

  const registry = new Map<string, Teardown>()
  scope[REGISTRY_KEY] = registry
  return registry
}

/**
 * Whether modules can be re-evaluated in this process.
 *
 * `bun --watch` restarts the process instead, which closes every connection on
 * its own, so `--hot` is the only mode that leaks. Everywhere else — production,
 * tests, CLI commands, serverless — nothing is ever torn down automatically.
 */
function isHotReloadRuntime(): boolean {
  return typeof process !== 'undefined' && Array.isArray(process.execArgv) && process.execArgv.includes('--hot')
}

/**
 * The source location that called a `create*Database()` factory.
 *
 * `stack` must come from an `Error` constructed inside the factory itself, so
 * frame 0 is `Error`, frame 1 is the factory, and frame 2 is the caller. A hot
 * reload re-runs the same line of the same file and reproduces this exactly;
 * two factories written side by side never share it.
 */
export function describeCallSite(stack: string | undefined): string | undefined {
  const caller = stack?.split('\n')[2]
  const location = caller?.match(/\(?([^()\s]+:\d+(?::\d+)?)\)?\s*$/)?.[1]
  return location ?? undefined
}

/**
 * Identity for a database handle across hot reloads, or `undefined` when the
 * handle must be left alone.
 */
export function hotReloadKey(driver: string, stack: string | undefined, target: string): string | undefined {
  if (!isHotReloadRuntime()) {
    return undefined
  }

  const callSite = describeCallSite(stack)
  if (!callSite) {
    return undefined
  }

  // The target is part of the key so a factory helper that opens one database
  // per tenant from a single line does not collapse them all into one slot.
  return `${driver}|${callSite}|${target}`
}

/**
 * Records `teardown` as the active client for `key` and closes whichever client
 * held the slot before it.
 *
 * `timeoutMs` exists so tests can exercise the give-up path without waiting out
 * the real budget; callers should leave it at the default.
 */
export async function replaceActiveConnection(
  key: string,
  teardown: Teardown,
  timeoutMs: number = TEARDOWN_TIMEOUT_MS,
): Promise<void> {
  const registry = getRegistry()
  const previous = registry.get(key)
  registry.set(key, teardown)

  if (!previous || previous === teardown) {
    return
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([
      Promise.resolve(previous()),
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(() => {
          console.warn(
            `[guren/orm] The previous database connection did not close within ${timeoutMs}ms; continuing without it.`,
          )
          resolveTimeout()
        }, timeoutMs)
      }),
    ])
  } catch (error) {
    console.warn('[guren/orm] Failed to close the previous database connection:', error)
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/**
 * Frees the slot held by `teardown`, unless a newer client already took it.
 */
export function releaseActiveConnection(key: string, teardown: Teardown): void {
  const registry = getRegistry()

  if (registry.get(key) === teardown) {
    registry.delete(key)
  }
}
