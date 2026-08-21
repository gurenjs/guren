import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { consola } from 'consola'
import { Router, mountModuleRoutes, type GurenModule, type RouteDefinition } from '@guren/core'
import { isDefinitelyAbsent, listModuleNames } from './discovery'
import { DEFAULT_ROUTES_FILE, REGISTRAR_EXPORT_NAMES, REGISTRAR_PATTERN } from './route-registrar'

type RouteRegistrar = (router: Router) => void | Promise<void>

// Re-exported so the many commands that resolve the routes entry file keep
// importing it from here; the constant lives beside the registrar name
// contract, which the scaffolders need without pulling in `@guren/core`.
export { DEFAULT_ROUTES_FILE } from './route-registrar'

export interface RoutesFileTarget {
  /** The path to load, as given or as defaulted. */
  path: string
  /**
   * Nothing to load, and that is a legitimate shape rather than a failure —
   * so the caller degrades to a route-less view in silence.
   */
  silentlyAbsent: boolean
}

/**
 * Which routes file to load, and whether its absence is an answer or a
 * failure.
 *
 * Two rules in one place because they only make sense together. An app with
 * no routes file at all is legitimate — api-only, mid-scaffold — and reports
 * nothing; `guren check` is where a missing entry file is diagnosed. But a
 * caller that *named* the file is a different question: a path that is not
 * there is a typo or a wrong app root, and reporting "no routes" for it is
 * the confident wrong answer #482 exists to prevent.
 *
 * An empty value names nothing, so `--routes=` is the default path, not a
 * file called "". Left to each call site, that distinction went wrong the
 * same way twice: `--health=` applied named-file strictness to the default
 * *search*, and `--routes=` resolved to the app root and reported
 * `Cannot find module '<app root>'` — a diagnostic naming a directory the
 * user never typed.
 *
 * Every caller that degrades a missing routes file asks through here, because
 * `guren context`, `guren context <Entity>` and `spec:generate` must not
 * disagree about the same app — and have: #482 fixed the entity bundle's
 * half of this rule and left the other two spelling it themselves.
 */
export async function resolveRoutesFile(
  cwd: string,
  routesFile?: string,
): Promise<RoutesFileTarget> {
  const path = routesFile || DEFAULT_ROUTES_FILE

  return { path, silentlyAbsent: !routesFile && (await isDefinitelyAbsent(cwd, path)) }
}

function resolveRegistrar(moduleExports: Record<string, unknown>): RouteRegistrar | undefined {
  for (const name of REGISTRAR_EXPORT_NAMES) {
    const candidate = moduleExports[name]
    if (typeof candidate === 'function') {
      return candidate as RouteRegistrar
    }
  }

  for (const [name, candidate] of Object.entries(moduleExports)) {
    if (REGISTRAR_PATTERN.test(name) && typeof candidate === 'function') {
      return candidate as RouteRegistrar
    }
  }

  return undefined
}

function isGurenModule(value: unknown): value is GurenModule {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as { name?: unknown }).name === 'string'
    && Array.isArray((value as { providers?: unknown }).providers)
  )
}

function resolveGurenModule(moduleExports: Record<string, unknown>): GurenModule | undefined {
  if (isGurenModule(moduleExports.default)) {
    return moduleExports.default
  }

  for (const value of Object.values(moduleExports)) {
    if (isGurenModule(value)) {
      return value
    }
  }

  return undefined
}

/**
 * Every load here is a plain `import()` of the file URL, so a process that
 * calls `loadRouteDefinitions()` twice sees the route graph as it was on the
 * *first* call. Bun keys `.ts` modules on the resolved path and ignores the
 * query string, so the usual `?v=<timestamp>` cache-busting trick does not
 * re-evaluate anything (verified on Bun 1.3.11 and 1.3.14, for both `.ts` and
 * `.js`), and Bun exposes no way to evict an ES module. A query-string variant
 * would also unify with the plain `routes/web.js` specifier an app boots
 * with, making that startup import the first load. Transitive imports —
 * controllers, a module's own `routes.ts` — are never re-evaluated on any
 * runtime either, so no entry-file-only trick could make the whole graph
 * fresh even if Bun did honor the query string.
 *
 * That is fine for one-shot CLI commands and the Vite plugin (which spawns
 * `guren` as a child process), so every call there is already a fresh
 * process. Long-lived in-process callers must instead run the CLI in a fresh
 * child process themselves — see `createFreshContextApi()` in
 * `fresh-context.ts`, used by the long-lived MCP dev server.
 */
function importUrl(file: string): string {
  return pathToFileURL(file).href
}

/** Shared tail for both "module skipped" warnings — keep the wording in one place. */
const ROUTES_MISSING_CONSEQUENCE =
  'its routes will be missing from generated types, audit results, and the OpenAPI spec'

/**
 * Loads a `modules/<name>/index.ts` and returns its `defineModule()` result,
 * or `undefined` (with a warning) if the module can't be imported or doesn't
 * export a recognizable `GurenModule`. Non-fatal on purpose — this is a
 * directory-scan discovery, so a module mid-scaffold or a stray directory
 * under `modules/` shouldn't break `guren codegen`/`audit`/`routes`/
 * `openapi:generate` for the whole app. The warning is always logged via
 * consola *and* appended to `warnings` when the caller passes one (`guren
 * audit` turns these into structured findings, so a skipped module's
 * unaudited routes surface in `--json` output and can fail CI, not just
 * scroll past in a console log).
 */
async function loadGurenModule(appRoot: string, moduleName: string, warnings?: string[]): Promise<GurenModule | undefined> {
  const indexPath = resolve(appRoot, 'modules', moduleName, 'index.ts')

  const warn = (message: string): void => {
    consola.warn(message)
    warnings?.push(message)
  }

  let moduleExports: Record<string, unknown>
  try {
    moduleExports = await import(importUrl(indexPath)) as Record<string, unknown>
  } catch (error) {
    warn(
      `Could not import modules/${moduleName}/index.ts — ${ROUTES_MISSING_CONSEQUENCE}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }

  const gurenModule = resolveGurenModule(moduleExports)
  if (!gurenModule) {
    warn(
      `modules/${moduleName}/index.ts doesn't export a defineModule() result — ${ROUTES_MISSING_CONSEQUENCE}.`,
    )
  }

  return gurenModule
}

/**
 * Loads every route in the app — the top-level `routesFile` plus every
 * `modules/*` module's own routes, mounted the same way `Application`
 * mounts them at boot (via the shared `mountModuleRoutes()`) — so
 * `guren codegen`/`audit`/`routes`/`openapi:generate` see exactly the
 * routes that will actually serve. `appRoot` is required (not derived from
 * `routesFile`) because `--routes <file>` lets callers point at a routes
 * file anywhere, including nested under a `routes/` directory — `dirname()`
 * of that path is not reliably the app root modules live under.
 *
 * Module discovery is directory-scan based (any `modules/<name>/` present),
 * not `createApp({ modules })`-based — consistent with how `guren check
 * --arch`'s derived module boundary rules already treat module presence.
 * A module directory that exists on disk but isn't passed to `createApp()`
 * will still show up here (typed routes, audit coverage) even though it
 * won't actually be mounted at runtime.
 *
 * `moduleWarnings`, when passed, collects one message per module that was
 * skipped (import failure or no recognizable `GurenModule` export) — see
 * `loadGurenModule`.
 *
 * `moduleProvenance`, when passed, receives one entry per returned
 * definition (same order): the module name that mounted the route, or
 * `null` for routes from the top-level routes file. Lets entity-scoped
 * consumers attribute routes to a bounded context.
 */
export async function loadRouteDefinitions(
  routesFile: string,
  appRoot: string,
  moduleWarnings?: string[],
  moduleProvenance?: Array<string | null>,
): Promise<RouteDefinition[]> {
  const moduleExports = await import(importUrl(routesFile)) as Record<string, unknown>
  const registrar = resolveRegistrar(moduleExports)

  if (!registrar) {
    throw new Error(
      `No route registrar export found in ${routesFile}. Export a register*Routes function (e.g. registerRoutes, registerWebRoutes, registerApiRoutes) or a default (router) => void.`,
    )
  }

  const router = new Router()
  await registrar(router)
  let definitionCount = router.definitions().length
  moduleProvenance?.push(...Array.from({ length: definitionCount }, () => null))

  const moduleNames = await listModuleNames(appRoot)

  for (const moduleName of moduleNames) {
    const gurenModule = await loadGurenModule(appRoot, moduleName, moduleWarnings)
    if (gurenModule) {
      await mountModuleRoutes(router, gurenModule)
      const mounted = router.definitions().length
      moduleProvenance?.push(...Array.from({ length: mounted - definitionCount }, () => moduleName))
      definitionCount = mounted
    }
  }

  return router.definitions()
}
