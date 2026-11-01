import { resolve } from 'node:path'
import type { ViteDevServer } from 'vite'
import { UI_COMPONENTS_DIR } from '../guren-css'
import { UI_CATALOG_CLIENT_ID, UI_CATALOG_ENTRY_ID, UI_CATALOG_PREVIEW_PATH, uiCatalogClientSource, uiCatalogEntrySource, uiCatalogHtml } from '../ui-catalog'

const RESOLVED_ENTRY = `\0${UI_CATALOG_ENTRY_ID}`
const RESOLVED_CLIENT = `\0${UI_CATALOG_CLIENT_ID}`

/**
 * The hooks behind the Dev Center's component catalog (`/_guren/ui`), carried by `routeTypesPlugin()` so
 * an app's existing `vite.config.ts` serves it. Dev server only: nothing here reaches a build.
 */
export function uiCatalogHooks(appRoot: () => string) {
  return {
    resolveId(id: string): string | undefined {
      if (id === UI_CATALOG_ENTRY_ID) return RESOLVED_ENTRY
      if (id === UI_CATALOG_CLIENT_ID) return RESOLVED_CLIENT
      return undefined
    },
    load(id: string): string | undefined {
      if (id === RESOLVED_ENTRY) return uiCatalogEntrySource(appRoot())
      if (id === RESOLVED_CLIENT) return uiCatalogClientSource()
      return undefined
    },
    configureServer(server: ViteDevServer): void {
      server.middlewares.use(UI_CATALOG_PREVIEW_PATH, (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        server.transformIndexHtml(UI_CATALOG_PREVIEW_PATH, uiCatalogHtml(), req.originalUrl).then((html) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(html)
        }, next)
      })
      // The entry lists the copies on disk, so `guren add ui` adding one must reach the next load.
      const onCopy = (file: string) => {
        if (!resolve(file).startsWith(`${resolve(appRoot(), UI_COMPONENTS_DIR)}/`)) return
        const module = server.moduleGraph?.getModuleById(RESOLVED_ENTRY)
        if (module) server.moduleGraph.invalidateModule(module)
      }
      server.watcher.on('add', onCopy)
      server.watcher.on('unlink', onCopy)
    },
  }
}
