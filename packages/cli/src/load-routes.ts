import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { consola } from 'consola'
import { Router, mountModuleRoutes, type GurenModule, type RouteDefinition } from '@guren/core'
import { listModuleNames } from './discovery'

type RouteRegistrar = (router: Router) => void | Promise<void>

/** Conventional routes entry file, shared by every command that loads routes. */
export const DEFAULT_ROUTES_FILE = 'routes/web.ts'

const REGISTRAR_EXPORTS = [
  'registerRoutes',
  'registerWebRoutes',
  'registerApiRoutes',
  'registerAuthRoutes',
  'default',
] as const

const REGISTRAR_PATTERN = /^register\w*Routes$/u

function resolveRegistrar(moduleExports: Record<string, unknown>): RouteRegistrar | undefined {
  for (const name of REGISTRAR_EXPORTS) {
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

function createImportUrl(file: string): string {
  const url = pathToFileURL(file)
  url.searchParams.set('guren-load-routes', `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  return url.href
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
    moduleExports = await import(createImportUrl(indexPath)) as Record<string, unknown>
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
  const moduleExports = await import(createImportUrl(routesFile)) as Record<string, unknown>
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
