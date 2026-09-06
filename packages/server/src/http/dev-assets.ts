import type { Context } from 'hono'
import { serveStatic } from 'hono/bun'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import type { Application } from './Application'
import { registerRootPublicAssets, type RootPublicAssetsConfig } from './public-assets'
import { applyDocumentDisposition, guardStaticDocument } from './static-documents'
import { isPathWithin, isRealPathWithin } from '../support/contained-path'

declare const Bun: any

const DEFAULT_PREFIX = '/resources/js'
const DEFAULT_VENDOR_PATH = '/vendor/inertia-client.tsx'
const DEFAULT_JSX_RUNTIME = 'https://esm.sh/react@19.0.0/jsx-dev-runtime?dev'
const REACT_IMPORT_PATTERN = /from\s+['"]react['"]/u

/** What {@link transpileFile} needs beyond the path it is asked to serve. */
interface TranspileContext {
  // Keyed by loader name, so the key that selects a transpiler is the same
  // expression passed as `transformSync`'s `loader`.
  tsx: any
  ts: any
  jsxRuntimeUrl: string
}

/**
 * The vendored Inertia client's mount point: containing directory (always
 * slash-terminated), Hono route pattern, and the file's path relative to it.
 */
export function resolveInertiaClientRoute(inertiaClientPath: string): {
  base: string
  pattern: string
  requestPath: string
} {
  const base = inertiaClientPath.slice(0, inertiaClientPath.lastIndexOf('/') + 1) || '/'
  return {
    base,
    pattern: `${base}*`,
    requestPath: inertiaClientPath.slice(base.length),
  }
}

export interface DevAssetsOptions {
  /** Absolute path to the resources directory (e.g. `/app/resources`). */
  resourcesDir?: string
  /** Base import meta that relative paths resolve against. */
  importMeta?: ImportMeta
  /** Relative path from `importMeta` to the resources directory. Defaults to `../resources`. */
  resourcesPath?: string
  /** Path prefix to mount transpiled JS assets. Defaults to `/resources/js`. */
  prefix?: string
  /** Route pattern serving raw CSS assets. Defaults to `/resources/css/*`. */
  cssRoute?: string
  /** Absolute path to the CSS directory. Defaults to `<resourcesDir>/../css`. */
  cssDir?: string
  /** Enables serving the bundled inertia client. Defaults to true. */
  inertiaClient?: boolean
  /** Path to the inertia client source. Defaults to the version bundled with Guren. */
  inertiaClientSource?: string
  /** Public URL for the inertia client. Defaults to `/vendor/inertia-client.tsx`. */
  inertiaClientPath?: string
  /** Override the remote JSX runtime URL. */
  jsxRuntimeUrl?: string
  /** Absolute path to a directory with static assets (e.g. `/app/public`). */
  publicDir?: string
  /** Relative path from `importMeta` to the static assets directory. Defaults to `../public`. */
  publicPath?: string | false
  /** Route pattern used when serving static assets. Defaults to `/public/*`. */
  publicRoute?: string
  /** Whether to register a no-op favicon route. Defaults to true when static assets are served. */
  favicon?: boolean
  /** Serve selected files from the public directory without the `/public` prefix. */
  rootPublicAssets?: RootPublicAssetsConfig
  /**
   * Serve document types (`.svg`, `.html`, XML) inline rather than as
   * downloads. Off by default: `public/` is also where uploads land, and a
   * stored `.html` or `.svg` served inline is script in the app's own origin.
   * The root-level allowlist route has its own `rootPublicAssets:
   * { inlineDocuments: true }`.
   */
  inlineDocuments?: boolean
}

// Lazily: @guren/inertia-client is an optional peer, and API-only apps must be
// able to import this module without it installed.
const require = createRequire(import.meta.url)
function resolveGurenInertiaClient(): string {
  // Dev wants the `./app` specifier's answer, sources included — the transpile
  // route serves a `src/app.tsx` from a tsconfig `paths` mapping just fine.
  return require.resolve('@guren/inertia-client/app')
}

/**
 * `@guren/inertia-client`'s build output. Anchored on `./package.json` rather
 * than a code subpath, because production serves files and cannot transpile: a
 * tsconfig `paths` mapping misses that subpath (there is no `src/package.json`)
 * and real package resolution answers with the package root.
 */
export function resolveInertiaClientDir(): string {
  return join(dirname(require.resolve('@guren/inertia-client/package.json')), 'dist')
}

export function registerDevAssets(app: Application, options: DevAssetsOptions): void {
  if (typeof Bun === 'undefined') {
    throw new Error('Bun runtime is required for dev asset serving.')
  }

  const moduleDir = options.importMeta ? dirname(fileURLToPath(options.importMeta.url)) : undefined

  const resourcesDir = options.resourcesDir ?? (moduleDir ? resolve(moduleDir, options.resourcesPath ?? '../resources') : undefined)

  if (!resourcesDir) {
    throw new Error('registerDevAssets requires either `resourcesDir` or `importMeta`.')
  }

  const prefix = options.prefix ?? DEFAULT_PREFIX
  const cssDir = options.cssDir ?? resolve(resourcesDir, 'css')
  const cssRoute = options.cssRoute ?? deriveCssRoute(prefix)
  const inertiaClientPath = options.inertiaClientPath ?? DEFAULT_VENDOR_PATH
  const inertiaClientSource = options.inertiaClientSource ?? resolveGurenInertiaClient()
  const jsxRuntimeUrl = options.jsxRuntimeUrl ?? DEFAULT_JSX_RUNTIME

  const resourcesJsDir = resolve(resourcesDir, 'js')

  const transpilerOptions = {
    target: 'browser' as const,
    jsx: 'transform' as const,
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
    },
  }

  const transpile: TranspileContext = {
    tsx: new Bun.Transpiler({ loader: 'tsx', ...transpilerOptions }),
    ts: new Bun.Transpiler({ loader: 'ts', ...transpilerOptions }),
    jsxRuntimeUrl,
  }

  app.hono.get(`${prefix}/*`, (ctx) => handleTranspileRequest(ctx, resourcesJsDir, prefix, transpile))

  if (cssDir) {
    const cssRewrite = createStaticRewrite(cssRoute)
    app.use(
      cssRoute,
      serveStatic({
        root: cssDir,
        rewriteRequestPath: cssRewrite,
        onFound: options.inlineDocuments ? undefined : guardStaticDocument,
      }),
    )
  }

  if (options.inertiaClient !== false) {
    const inertiaClientDir = dirname(inertiaClientSource)
    const {
      base: inertiaClientBase,
      pattern: inertiaClientPattern,
      requestPath: inertiaClientRequestPath,
    } = resolveInertiaClientRoute(inertiaClientPath)

    app.hono.get(inertiaClientPattern, (ctx) => {
      const relativeRequest = ctx.req.path.slice(inertiaClientBase.length) || inertiaClientRequestPath

      // Not request-derived, so no containment check: the resolved module may
      // legitimately be a symlink out of `inertiaClientDir`.
      if (relativeRequest === inertiaClientRequestPath) {
        return transpileFile(inertiaClientSource, transpile)
      }

      const candidatePath = resolve(inertiaClientDir, relativeRequest)

      if (!isPathWithin(inertiaClientDir, candidatePath)) {
        return ctx.notFound()
      }

      return transpileFile(candidatePath, transpile, inertiaClientDir)
    })
  }

  const publicPathOption = options.publicPath === undefined ? '../public' : options.publicPath
  const publicDir = options.publicDir ?? (moduleDir && publicPathOption ? resolve(moduleDir, publicPathOption) : undefined)
  const shouldServePublic = publicDir && publicPathOption !== false

  if (shouldServePublic) {
    const publicRoute = options.publicRoute ?? '/public/*'
    const rewriteRequestPath = createStaticRewrite(publicRoute)
    app.use(
      publicRoute,
      serveStatic({
        root: publicDir,
        rewriteRequestPath,
        onFound: options.inlineDocuments ? undefined : guardStaticDocument,
      }),
    )

    if (options.favicon !== false) {
      app.hono.get('/favicon.ico', () => new Response(null, { status: 204 }))
    }

    registerRootPublicAssets(app, publicDir, options.rootPublicAssets)
  }
}

export function createStaticRewrite(route: string): (path: string) => string {
  const wildcardIndex = route.indexOf('*')
  const base = wildcardIndex >= 0 ? route.slice(0, wildcardIndex) : route
  const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base

  if (!normalizedBase) {
    return (path: string) => (path || '/')
  }

  return (path: string) => {
    if (!path.startsWith(normalizedBase)) {
      return path || '/'
    }

    const remainder = path.slice(normalizedBase.length)

    if (!remainder) {
      return '/'
    }

    return remainder.startsWith('/') ? remainder : `/${remainder}`
  }
}

async function handleTranspileRequest(
  ctx: Context,
  resourcesJsDir: string,
  prefix: string,
  transpile: TranspileContext,
): Promise<Response> {
  const relative = ctx.req.path.slice(prefix.length + 1)
  const fsPath = resolve(resourcesJsDir, relative)

  if (!isPathWithin(resourcesJsDir, fsPath)) {
    return ctx.notFound()
  }

  return transpileFile(fsPath, transpile, resourcesJsDir)
}

/**
 * Transpiles TS/TSX, otherwise serves the file as-is.
 *
 * @param containmentRoot Directory the resolved file must really live under.
 *   Omit for configured (non request-derived) paths.
 */
async function transpileFile(
  fsPath: string,
  transpile: TranspileContext,
  containmentRoot?: string,
): Promise<Response> {
  const candidates = buildCandidatePaths(fsPath)
  let filePath: string | undefined
  let file: any

  for (const candidate of candidates) {
    const bunFile = Bun.file(candidate)
    // eslint-disable-next-line no-await-in-loop -- sequential checks keep filesystem pressure minimal
    if (await bunFile.exists()) {
      filePath = candidate
      file = bunFile
      break
    }
  }

  if (!file || !filePath) {
    return new Response('Not Found', { status: 404 })
  }

  // Judged here: the extension probing above settles which file gets read, and
  // `filePath` is now known to exist, the precondition for canonicalizing it.
  if (containmentRoot && !(await isRealPathWithin(containmentRoot, filePath))) {
    return new Response('Not Found', { status: 404 })
  }

  const ext = extname(filePath)
  let source = await file.text()

  if (ext === '.tsx' && !REACT_IMPORT_PATTERN.test(source)) {
    source = "import React from 'react'\n" + source
  }

  if (ext === '.tsx' || ext === '.ts') {
    const loader = ext === '.tsx' ? 'tsx' : 'ts'
    const transpiled = transpile[loader].transformSync(source, {
      loader,
      sourceMap: isDev() ? 'inline' : false,
      filename: filePath,
    })

    const helpers = collectJsxHelpers(transpiled)
    const runtimeShim = helpers.size ? createJsxRuntimeShim(helpers, transpile.jsxRuntimeUrl) : ''

    return new Response(runtimeShim + transpiled, {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': isDev() ? 'no-cache' : 'public, max-age=31536000',
      },
    })
  }

  const body = await file.arrayBuffer()
  const contentType = file.type || 'application/octet-stream'
  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': isDev() ? 'no-cache' : 'public, max-age=31536000',
  })

  // Non-TypeScript is handed back as it sits on disk. No `inlineDocuments`
  // switch: the two directories reachable here hold the app's own sources and
  // the vendored client, not the uploads that escape hatch exists for.
  applyDocumentDisposition(headers, contentType)

  return new Response(body, { headers })
}

function buildCandidatePaths(fsPath: string): string[] {
  const ext = extname(fsPath)

  if (ext) {
    return [fsPath]
  }

  return [
    `${fsPath}.tsx`,
    `${fsPath}.ts`,
    `${fsPath}.jsx`,
    `${fsPath}.js`,
  ]
}

function collectJsxHelpers(code: string): Set<string> {
  const helpers = new Set<string>()
  const pattern = /(jsxDEV|jsx|jsxs|Fragment)_[0-9a-z]+/gu
  for (const match of code.matchAll(pattern)) {
    helpers.add(match[0])
  }
  return helpers
}

function createJsxRuntimeShim(helpers: Set<string>, runtimeUrl: string): string {
  const assignments = Array.from(helpers).map((helper) => {
    const base = helper.split('_')[0]
    return `const ${helper} = __jsxRuntime.${base};`
  })

  return `import * as __jsxRuntime from "${runtimeUrl}";\n${assignments.join('\n')}\n`
}

function isDev(): boolean {
  return (process.env.NODE_ENV || 'development') !== 'production'
}

function deriveCssRoute(prefix: string): string {
  const base = prefix.endsWith('/js') ? prefix.slice(0, -3) : prefix
  const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base
  const resolvedBase = normalizedBase.startsWith('/') ? normalizedBase : `/${normalizedBase}`
  return `${resolvedBase}/css/*`
}
