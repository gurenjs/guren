import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { consola } from 'consola'
import type { ApiTokenStore, RouteDefinition } from '@guren/core'

const MAIN_ENTRY_CANDIDATES = [
  'src/main.ts',
  'src/main.mts',
  'src/main.js',
  'src/main.mjs',
  'dist/main.js',
]

export type MaybeApplication = {
  /**
   * Resolves to the bound address on a current `@guren/server`. The `unknown`
   * arm is not defensive padding — `guren dev` imports the *user's* app, which
   * may resolve a version whose `listen()` predates the return value.
   */
  listen?: (options?: {
    port?: number
    hostname?: string
  }) => unknown | Promise<{ port: number; hostname: string; url: string } | undefined>
  boot?: () => Promise<void> | void
  /**
   * The app's auth manager, as much of it as a command may touch. Structural
   * and optional all the way down for the same reason `listen` carries an
   * `unknown` arm: the app being loaded is the *user's*, and may resolve a
   * `@guren/core` older than `getApiTokenStore()`. A missing method has to
   * reach the caller's own diagnostic ("call `useTokens(store)`") rather than
   * a `TypeError` naming an internal.
   */
  /** Bun's listener handle, when the app is one that reports having a server. */
  stop?: (closeConnections?: boolean) => void | Promise<void>
  auth?: {
    getApiTokenStore?: () => ApiTokenStore | undefined
    /**
     * The options the app's own `useTokens()` used, so machinery replacing
     * the store changes where tokens live and nothing else.
     */
    getApiTokenOptions?: () => { provider?: string; guardName?: string; updateLastUsed?: boolean }
    /**
     * Installs a token store over whatever the app configured, which is how
     * `tool:dev` issues a credential that cannot outlive its process. Same
     * structural-and-optional reasoning as the accessor above.
     */
    useTokens?: (store: ApiTokenStore, options?: { provider?: string; guardName?: string }) => void
  }
  /**
   * The app-local route registry, for the commands that must read the graph
   * the *booted* app serves rather than the one on disk (`guren tool:call`).
   * Optional for the same reason `auth` is: an app resolving a `@guren/core`
   * without the agent interface has no such registry, and that must reach the
   * caller's own diagnostic instead of a `TypeError`.
   */
  router?: {
    definitions?: () => RouteDefinition[]
  }
  /** The app's HTTP entry, when it has one — `tool:call` re-enters through it. */
  fetch?: (request: Request) => Response | Promise<Response>
  /**
   * The app's service container, for the commands that must reach a service
   * the *application* configured rather than one they can construct
   * (`guren tool:call` resolves `'agent.audit'` through it).
   *
   * Structural and optional like everything else here, and deliberately down
   * to the method level: an app on a `@guren/core` predating a binding, or one
   * whose container is some other object entirely, must reach the caller's own
   * fallback rather than a `TypeError`. `make` is declared as *possibly*
   * throwing in the caller's handling, not in this type — a container resolving
   * a factory that fails does throw, and a command recording what it did may
   * not fail the thing it is recording.
   */
  container?: {
    has?: (key: string) => boolean
    make?: <T>(key: string) => T
  }
}

export async function resolveMainEntry(appRoot?: string): Promise<string> {
  // A caller that resolved anything *else* about the app from an explicit
  // root has to resolve the entry from that same root. `token:issue` derives
  // its tool list from `--app` and writes the token into the store this
  // returns: reading `process.cwd()` here made those two different
  // applications, so the command printed one app's tools and granted them in
  // another.
  const cwd = appRoot ? resolve(process.cwd(), appRoot) : process.cwd()

  for (const candidate of MAIN_ENTRY_CANDIDATES) {
    const absolute = resolve(cwd, candidate)
    try {
      await access(absolute)
      return absolute
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }

      throw error
    }
  }

  throw new Error('Could not locate an application entry point (expected one of src/main.{ts,js} or dist/main.js).')
}

export async function bootstrapApplication(mod: Record<string, unknown>): Promise<MaybeApplication> {
  const results: Array<unknown> = []

  const ready = mod.ready
  if (ready && typeof (ready as Promise<unknown>).then === 'function') {
    try {
      results.push(await ready)
    } catch (error) {
      throw new Error(`Application ready() promise rejected: ${String(error)}`)
    }
  }

  if (typeof mod.bootstrap === 'function') {
    results.push(await (mod.bootstrap as () => Promise<unknown>)())
  }

  const candidates = [
    ...results,
    mod.default,
    (mod as { app?: unknown }).app,
  ]

  for (const candidate of candidates) {
    if (candidate && typeof (candidate as MaybeApplication).listen === 'function') {
      return candidate as MaybeApplication
    }
  }

  throw new Error('Application entry must export a default or ready/bootstrap that yields an object with a listen() method.')
}

/**
 * Resolve the app's entry, import it, bootstrap it, and boot it — the block
 * every command that must reach a *live* application performs.
 *
 * `boot()` failures are rethrown rather than warned about, and that is the
 * whole reason this is a helper rather than four lines at each call site: a
 * command reaching into a half-booted app reads state whose configuration
 * never completed. A provider that failed after auth registered leaves a store
 * that *looks* configured, so a token minted against it is written into an
 * application that never finished booting — and reported as a success. What
 * that costs differs per command, so each call site says so in its own words.
 */
export async function loadBootedApplication(appRoot?: string): Promise<MaybeApplication> {
  // The same root everything else about the app was resolved from — see
  // `resolveMainEntry`.
  const entry = await resolveMainEntry(appRoot)

  let moduleExports: Record<string, unknown>
  try {
    moduleExports = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `Failed to import application entry (${entry}): ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const app: MaybeApplication = await bootstrapApplication(moduleExports)
  await ensureApplicationBooted(app, moduleExports, { rethrow: true })
  return app
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as PromiseLike<unknown>).then === 'function'
}

function moduleHandlesBoot(moduleExports: Record<string, unknown>): boolean {
  const ready = moduleExports.ready
  if (isPromiseLike(ready)) {
    return true
  }

  const bootstrap = moduleExports.bootstrap
  return typeof bootstrap === 'function'
}

export async function ensureApplicationBooted(
  app: MaybeApplication,
  moduleExports: Record<string, unknown>,
  options: { rethrow?: boolean } = {},
): Promise<void> {
  if (moduleHandlesBoot(moduleExports)) {
    return
  }

  const maybeBoot = (app as { boot?: () => Promise<void> }).boot
  if (typeof maybeBoot !== 'function') {
    return
  }

  try {
    await maybeBoot.call(app)
  } catch (error) {
    // Warn-and-continue suits a command that only inspects a half-built app
    // (`console` still gives a usable REPL). A command that *writes* through
    // one must not: a provider that failed after auth registered leaves a
    // store that looks configured, so `token:issue` would mint into an
    // application that never finished booting and report success.
    if (options.rethrow) throw error
    consola.warn('Application boot() rejected:', error)
  }
}

export async function importFirstAvailableApplicationModule(paths: string[]): Promise<{ module: Record<string, unknown>; path: string } | undefined> {
  const cwd = process.cwd()

  for (const relative of paths) {
    const absolute = resolve(cwd, relative)

    try {
      await access(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }

      throw error
    }

    try {
      const module = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>
      return { module, path: absolute }
    } catch (error) {
      consola.warn(`Failed to import ${relative}:`, error)
    }
  }

  return undefined
}
