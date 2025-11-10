import { extname, resolve } from 'node:path'
import type { Application } from './Application'

declare const Bun: any

const DEFAULT_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const DEFAULT_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif', '.webmanifest', '.txt'] as const
const DEFAULT_CONTENT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
}

export type RootPublicAssetsConfig = boolean | RootPublicAssetsOptions

export interface RootPublicAssetsOptions {
  /** Enable or disable root-level public asset serving. Defaults to true. */
  enabled?: boolean
  /** List of file extensions to expose from the public directory. */
  extensions?: string[]
  /** Cache-Control header applied to served files. */
  cacheControlHeader?: string
  /** Optional prefix filter (e.g. `/assets`). Defaults to all paths. */
  routePrefix?: string
  /** Override content types per extension. */
  contentTypeMap?: Record<string, string>
}

type NormalizedConfig = {
  extensions: Set<string>
  cacheControlHeader: string
  routePrefix?: string
  contentTypeMap?: Record<string, string>
}

export function registerRootPublicAssets(app: Application, publicDir: string, config?: RootPublicAssetsConfig): void {
  const normalized = normalizeConfig(config)

  if (!normalized) {
    return
  }

  if (typeof Bun === 'undefined') {
    console.warn('Root public asset serving is only available when running on Bun; skipping registration.')
    return
  }

  const { extensions, cacheControlHeader, routePrefix, contentTypeMap } = normalized
  const normalizedPrefix = routePrefix ? routePrefix.replace(/\/+$/u, '') || '/' : undefined

  app.hono.use(async (ctx, next) => {
    const path = ctx.req.path

    if (!path || path === '/' || path.startsWith('/public/')) {
      return next()
    }

    if (normalizedPrefix && !path.startsWith(normalizedPrefix)) {
      return next()
    }

    const extension = extname(path).toLowerCase()

    if (!extensions.has(extension)) {
      return next()
    }

    const relativePath = path.replace(/^\/+/, '')

    if (!relativePath) {
      return next()
    }

    const candidatePath = resolve(publicDir, relativePath)

    if (!candidatePath.startsWith(publicDir)) {
      return next()
    }

    const file = Bun.file(candidatePath)

    if (!(await file.exists())) {
      return next()
    }

    const headers = new Headers({
      'Cache-Control': cacheControlHeader,
      'Content-Type': contentTypeMap?.[extension] ?? DEFAULT_CONTENT_TYPES[extension] ?? 'application/octet-stream',
    })

    return new Response(file, { headers })
  })
}

function normalizeConfig(config?: RootPublicAssetsConfig): NormalizedConfig | undefined {
  if (config === false) {
    return undefined
  }

  if (config === undefined || config === true) {
    return {
      extensions: new Set(DEFAULT_EXTENSIONS),
      cacheControlHeader: DEFAULT_CACHE_CONTROL,
    }
  }

  const enabled = config.enabled ?? true

  if (!enabled) {
    return undefined
  }

  const extensions = new Set(
    (config.extensions && config.extensions.length > 0 ? config.extensions : DEFAULT_EXTENSIONS).map((ext) =>
      normalizeExtension(ext),
    ),
  )

  return {
    extensions,
    cacheControlHeader: config.cacheControlHeader ?? DEFAULT_CACHE_CONTROL,
    routePrefix: config.routePrefix,
    contentTypeMap: config.contentTypeMap,
  }
}

function normalizeExtension(value: string): string {
  if (!value) {
    return value
  }

  return value.startsWith('.') ? value.toLowerCase() : `.${value.toLowerCase()}`
}
