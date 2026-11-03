import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ViteDevServer } from 'vite'
import { UI_COMPONENTS, UI_COMPONENTS_DIR, uiComponentPath } from '../guren-css'
import { parseSourceFile } from '../parse-cache'
import {
  UI_CATALOG_CLIENT_ID,
  UI_CATALOG_COMPONENT_PREFIX,
  UI_CATALOG_DEPENDENCIES,
  UI_CATALOG_ENTRY_ID,
  UI_CATALOG_PREVIEW_PATH,
  UI_CATALOG_STYLESHEET_ID,
  uiCatalogClientSource,
  uiCatalogEntrySource,
  uiCatalogHtml,
  uiCatalogStylesheet,
} from '../ui-catalog'

const RESOLVED_ENTRY = `\0${UI_CATALOG_ENTRY_ID}`
const RESOLVED_CLIENT = `\0${UI_CATALOG_CLIENT_ID}`

/**
 * What Vite pre-bundles for the preview before its first request. Vite crawls only the app's entry at startup, so it
 * found the preview's packages while serving it, re-bundling and reloading on each; a copy loaded in between could take
 * React from the newer bundle while the renderer held the older one (`Invalid hook call` in Field). Named in `include`
 * with every package a copy imports, since an edited copy may add any; `entries` would replace the entry's crawl.
 */
export async function uiCatalogPrebundled(appRoot: string): Promise<string[]> {
  const copies = await Promise.all(UI_COMPONENTS.map((name) => packagesImportedBy(resolve(appRoot, uiComponentPath(name)))))
  return [...new Set([...UI_CATALOG_DEPENDENCIES, ...copies.flat()])]
}

/** The packages a file imports at runtime: not `import type`, a relative or `@/` path, or a `node:`/`virtual:` id. */
async function packagesImportedBy(file: string): Promise<string[]> {
  const source = await readFile(file, 'utf8').catch(() => undefined)
  const ast = source === undefined ? null : parseSourceFile(source, file)
  if (!ast) return []
  return ast.program.body.flatMap((statement) => {
    if (statement.type === 'ImportDeclaration' && statement.importKind !== 'type') return [statement.source.value]
    if ((statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportAllDeclaration') && statement.source && statement.exportKind !== 'type') return [statement.source.value]
    return []
  }).filter((id) => /^(?:@[^/.]|[^./@#~])/u.test(id) && !id.includes(':'))
}

/**
 * The hooks behind the Dev Center's component catalog (`/_guren/ui`), carried by `routeTypesPlugin()` so
 * an app's existing `vite.config.ts` serves it. Dev server only: nothing here reaches a build.
 */
export function uiCatalogHooks(appRoot: () => string) {
  return {
    resolveId(id: string): string | undefined {
      // Vite asks every plugin about every import, so anything else leaves at once.
      if (!id.startsWith(UI_CATALOG_ENTRY_ID)) return undefined
      if (id === UI_CATALOG_ENTRY_ID) return RESOLVED_ENTRY
      if (id === UI_CATALOG_CLIENT_ID) return RESOLVED_CLIENT
      // Absolute files under the app root, which `routeTypesPlugin({ appRoot })` may set apart from Vite's root.
      if (id === UI_CATALOG_STYLESHEET_ID) {
        const stylesheet = uiCatalogStylesheet(appRoot())
        return stylesheet ? resolve(appRoot(), stylesheet) : undefined
      }
      const component = UI_COMPONENTS.find((name) => id === `${UI_CATALOG_COMPONENT_PREFIX}${name}`)
      return component ? resolve(appRoot(), uiComponentPath(component)) : undefined
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
