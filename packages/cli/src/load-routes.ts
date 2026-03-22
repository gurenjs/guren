import { pathToFileURL } from 'node:url'
import { Router, type RouteDefinition } from '@guren/core'

type RouteRegistrar = (router: Router) => void | Promise<void>

const REGISTRAR_EXPORTS = ['registerRoutes', 'registerWebRoutes', 'default'] as const

function resolveRegistrar(moduleExports: Record<string, unknown>): RouteRegistrar | undefined {
  for (const name of REGISTRAR_EXPORTS) {
    const candidate = moduleExports[name]
    if (typeof candidate === 'function') {
      return candidate as RouteRegistrar
    }
  }

  return undefined
}

function createImportUrl(routesFile: string): string {
  const url = pathToFileURL(routesFile)
  url.searchParams.set('guren-load-routes', `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  return url.href
}

export async function loadRouteDefinitions(routesFile: string): Promise<RouteDefinition[]> {
  const moduleExports = await import(createImportUrl(routesFile)) as Record<string, unknown>
  const registrar = resolveRegistrar(moduleExports)

  if (!registrar) {
    throw new Error(
      `No route registrar export found in ${routesFile}. Export registerRoutes, registerWebRoutes, or default (router) => void.`,
    )
  }

  const router = new Router()
  await registrar(router)
  return router.definitions()
}
