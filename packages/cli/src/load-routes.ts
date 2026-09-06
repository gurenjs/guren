import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { consola } from 'consola'
import { Router, mountModuleRoutes, type GurenModule, type RouteDefinition } from '@guren/core'
import { isDefinitelyAbsent, listModuleNames } from './discovery'
import { REGISTRAR_EXPORT_NAMES, REGISTRAR_PATTERN, routesEntryOrDefault } from './route-registrar'

type RouteRegistrar = (router: Router) => void | Promise<void>

// Lives beside the registrar name contract, which the scaffolders need without
// pulling in `@guren/core`; re-exported so route-resolving commands find it.
export { DEFAULT_ROUTES_FILE } from './route-registrar'

export interface RoutesFileTarget {
  /** The path to load, as given or as defaulted. */
  path: string
  /** Nothing to load, legitimately — the caller degrades in silence. */
  silentlyAbsent: boolean
}

/**
 * Which routes file to load, and whether its absence is an answer or a failure.
 * Unnamed means the app's entry by the probe `check` shares, and missing is then
 * legitimate (no routes yet); a path the caller *named* is a typo or a wrong app
 * root when missing (#482). An empty value names nothing, so `--routes=` probes.
 * Every degrading caller asks here, so `context` and `spec:generate` agree.
 */
export async function resolveRoutesFile(
  cwd: string,
  routesFile?: string,
): Promise<RoutesFileTarget> {
  const path = await routesEntryOrDefault(cwd, routesFile || undefined)

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
 * A plain `import()`, so a second `loadRouteDefinitions()` in one process sees
 * the first call's route graph. Bun keys `.ts` modules on the resolved path and
 * ignores the query string (verified on Bun 1.3.11 and 1.3.14), so `?v=<ts>`
 * busts nothing, and no runtime re-evaluates transitive imports anyway. Fine for
 * one-shot commands; a long-lived caller spawns a child — see `createFreshContextApi()`.
 */
function importUrl(file: string): string {
  return pathToFileURL(file).href
}

/** Shared tail for both "module skipped" warnings — keep the wording in one place. */
const ROUTES_MISSING_CONSEQUENCE =
  'its routes will be missing from generated types, audit results, and the OpenAPI spec'

/**
 * Non-fatal on purpose: this is a directory scan, so a module mid-scaffold or
 * a stray `modules/` directory must not break codegen for the whole app. The
 * warning also lands in `warnings` when passed — `guren audit` turns those
 * into structured findings, so a skipped module's routes can fail CI rather
 * than scroll past in a console log.
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
 * Every app route, module routes mounted through the shared `mountModuleRoutes()`
 * so static analyses see exactly what will serve. `appRoot` is required since
 * `--routes <file>` may point anywhere. Discovery is a directory scan (like
 * `check --arch`), so a module never passed to `createApp()` shows up here without
 * mounting. `moduleProvenance` gets one entry per definition, in order: module name or `null`.
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

/**
 * The preamble every `route:list`-shaped command shares, so they cannot
 * disagree about which app they describe: `--app` defaults to cwd, `--routes`
 * resolves against it — else the same entry probe `check` and `audit` use, so
 * an API-only app's `routes/api.ts` is found — and a load failure is re-thrown
 * naming the file.
 */
export async function loadAppRouteDefinitions(
  options: { appRoot?: string; routesFile?: string } = {},
): Promise<{ appRoot: string; routesFile: string; definitions: RouteDefinition[] }> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const routesFile = resolve(appRoot, await routesEntryOrDefault(appRoot, options.routesFile))

  try {
    return { appRoot, routesFile, definitions: await loadRouteDefinitions(routesFile, appRoot) }
  } catch (error) {
    throw new Error(
      `Failed to import routes file (${routesFile}): ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
