import { serveStatic } from 'hono/bun'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Application } from './Application'
import { createStaticRewrite, registerDevAssets, type DevAssetsOptions } from './dev-assets'

export interface InertiaAssetsOptions extends DevAssetsOptions {
  /** Default stylesheet entry embedded into Inertia responses. */
  stylesEntry?: string
  /** Default script entry embedded into Inertia responses (production). */
  scriptEntry?: string
}

const DEFAULT_STYLES_ENTRY = '/public/assets/app.css'
const DEFAULT_SCRIPT_ENTRY = '/assets/app.js'

export function configureInertiaAssets(app: Application, options: InertiaAssetsOptions): void {
  const stylesEntry = options.stylesEntry ?? DEFAULT_STYLES_ENTRY
  process.env.GUREN_INERTIA_STYLES = process.env.GUREN_INERTIA_STYLES ?? stylesEntry

  const isProduction = process.env.NODE_ENV === 'production'

  if (!isProduction) {
    registerDevAssets(app, options)
    return
  }

  const scriptEntry = options.scriptEntry ?? DEFAULT_SCRIPT_ENTRY
  process.env.GUREN_INERTIA_ENTRY = process.env.GUREN_INERTIA_ENTRY ?? scriptEntry

  const moduleDir = options.importMeta ? dirname(fileURLToPath(options.importMeta.url)) : undefined
  const publicPathOption = options.publicPath === undefined ? '../public' : options.publicPath
  const publicDir = options.publicDir ?? (moduleDir && publicPathOption ? resolve(moduleDir, publicPathOption) : undefined)

  if (!publicDir || publicPathOption === false) {
    return
  }

  const publicRoute = options.publicRoute ?? '/public/*'
  const rewriteRequestPath = createStaticRewrite(publicRoute)

  app.use(
    publicRoute,
    serveStatic({
      root: publicDir,
      rewriteRequestPath,
    }),
  )

  if (options.favicon !== false) {
    app.hono.get('/favicon.ico', () => new Response(null, { status: 204 }))
  }
}
