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
 * whatever it finds unconditionally. Connections have no such guarantee, so a
 * handle is identified by the file that built it and the database it points at.
 *
 * That pair is what survives an edit. Keying on the exact line would be more
 * precise, but a line number changes the moment anything above it does — adding
 * an import to `config/database.ts` would orphan the previous entry and leak the
 * connection it was holding, during the very workflow this exists to fix. The
 * file is stable across every edit that isn't a rename.
 *
 * The cost of that choice: two handles built in one file against one database —
 * separate pools for web requests and background jobs, say — share a key, so the
 * second replaces the first. Give them their own module to keep them apart. This
 * only runs under `--hot`, so the mistake surfaces immediately in dev rather
 * than anywhere it could reach production.
 */

type Teardown = () => Promise<void> | void

interface ActiveConnection {
  teardown: Teardown
  /** Resolves once this claim has finished closing the client it replaced. */
  settled: Promise<void>
}

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
  [REGISTRY_KEY]?: Map<string, ActiveConnection>
}

function getRegistry(): Map<string, ActiveConnection> {
  const scope = globalThis as GlobalWithRegistry
  const existing = scope[REGISTRY_KEY]

  if (existing) {
    return existing
  }

  const registry = new Map<string, ActiveConnection>()
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
 * The file that called a `create*Database()` factory.
 *
 * `stack` must come from an `Error` constructed inside the factory itself, so
 * frame 0 is `Error`, frame 1 is the factory, and frame 2 is the caller. Only
 * the path is kept: a reload re-runs the same file, but not necessarily at the
 * same line.
 */
export function describeCallerFile(stack: string | undefined): string | undefined {
  const caller = stack?.split('\n')[2]
  // Matched as one `file:line:column` run, then trimmed: letting the group stop
  // at the first `:` would leave the line number attached, since a greedy path
  // match backtracks no further than it has to.
  const location = caller?.match(/\(?([^()\s]+:\d+(?::\d+)?)\)?\s*$/)?.[1]
  return location?.replace(/:\d+(?::\d+)?$/, '') || undefined
}

/**
 * Identity for a database handle across hot reloads, or `undefined` when the
 * handle must be left alone.
 */
export function hotReloadKey(driver: string, stack: string | undefined, target: string): string | undefined {
  if (!isHotReloadRuntime()) {
    return undefined
  }

  const callerFile = describeCallerFile(stack)
  if (!callerFile) {
    return undefined
  }

  // The target is part of the key so one module opening a database per tenant
  // does not collapse them all into a single slot.
  return `${driver}|${callerFile}|${target}`
}

async function closeWithTimeout(teardown: Teardown, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([
      Promise.resolve(teardown()),
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
 * Records `teardown` as the active client for `key` and closes whichever client
 * held the slot before it.
 *
 * Claims on one key are serialized: a claim waits for the claim it supersedes to
 * finish its own replacement before tearing it down. Without that, three reloads
 * arriving inside the teardown window let the third close the second's client
 * while the second was still initializing, and the second would go on to hand
 * its caller a client that is already closed.
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

  if (previous?.teardown === teardown) {
    return
  }

  const settled = (async () => {
    if (!previous) {
      return
    }

    // Let the superseded claim finish before pulling its client out from under
    // it, then close it.
    await previous.settled.catch(() => {})
    await closeWithTimeout(previous.teardown, timeoutMs)
  })()

  registry.set(key, { teardown, settled })
  await settled
}

/**
 * Frees the slot held by `teardown`, unless a newer client already took it.
 */
export function releaseActiveConnection(key: string, teardown: Teardown): void {
  const registry = getRegistry()

  if (registry.get(key)?.teardown === teardown) {
    registry.delete(key)
  }
}
