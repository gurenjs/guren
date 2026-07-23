import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { consola } from 'consola'
import { Router, mountModuleRoutes, type GurenModule, type RouteDefinition } from '@guren/core'
import { listModuleNames } from './discovery'

type RouteRegistrar = (router: Router) => void | Promise<void>

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

/**
 * Loads a `modules/<name>/index.ts` and returns its `defineModule()` result,
 * or `undefined` (with a warning) if the module can't be imported or doesn't
 * export a recognizable `GurenModule`. Non-fatal on purpose — this is a
 * directory-scan discovery, so a module mid-scaffold or a stray directory
 * under `modules/` shouldn't break `guren codegen`/`audit`/`routes`/
 * `openapi:generate` for the whole app. The warning keeps it from being a
 * *silent* miss, which is the failure mode this loader exists to avoid.
 */
async function loadGurenModule(appRoot: string, moduleName: string): Promise<GurenModule | undefined> {
  const indexPath = resolve(appRoot, 'modules', moduleName, 'index.ts')

  let moduleExports: Record<string, unknown>
  try {
    moduleExports = await import(createImportUrl(indexPath)) as Record<string, unknown>
  } catch (error) {
    consola.warn(
      `Could not import modules/${moduleName}/index.ts — its routes will be missing from generated types, `
      + `audit results, and the OpenAPI spec: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }

  const gurenModule = resolveGurenModule(moduleExports)
  if (!gurenModule) {
    consola.warn(
      `modules/${moduleName}/index.ts doesn't export a defineModule() result — its routes will be missing `
      + `from generated types, audit results, and the OpenAPI spec.`,
    )
  }

  return gurenModule
}

/**
 * Loads every route in the app — the top-level `routesFile` plus every
 * `modules/*` module's own routes, mounted the same way `Application`
 * mounts them at boot (via the shared `mountModuleRoutes()`) — so
 * `guren codegen`/`audit`/`routes`/`openapi:generate` see exactly the
 * routes that will actually serve. `appRoot` defaults to `routesFile`'s
 * directory when omitted, matching the pre-modules behavior for callers
 * that haven't been updated.
 *
 * Module discovery is directory-scan based (any `modules/<name>/` present),
 * not `createApp({ modules })`-based — consistent with how `guren check
 * --arch`'s derived module boundary rules already treat module presence.
 * A module directory that exists on disk but isn't passed to `createApp()`
 * will still show up here (typed routes, audit coverage) even though it
 * won't actually be mounted at runtime.
 */
export async function loadRouteDefinitions(routesFile: string, appRoot?: string): Promise<RouteDefinition[]> {
  const moduleExports = await import(createImportUrl(routesFile)) as Record<string, unknown>
  const registrar = resolveRegistrar(moduleExports)

  if (!registrar) {
    throw new Error(
      `No route registrar export found in ${routesFile}. Export a register*Routes function (e.g. registerRoutes, registerWebRoutes, registerApiRoutes) or a default (router) => void.`,
    )
  }

  const router = new Router()
  await registrar(router)

  const root = appRoot ?? dirname(routesFile)
  const moduleNames = await listModuleNames(root)

  for (const moduleName of moduleNames) {
    const gurenModule = await loadGurenModule(root, moduleName)
    if (gurenModule) {
      await mountModuleRoutes(router, gurenModule)
    }
  }

  return router.definitions()
}
