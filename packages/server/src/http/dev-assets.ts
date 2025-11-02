import type { Context } from 'hono'
import { serveStatic } from 'hono/bun'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import type { Application } from './Application'

declare const Bun: any

const DEFAULT_PREFIX = '/resources/js'
const DEFAULT_VENDOR_PATH = '/vendor/inertia-client.tsx'
const DEFAULT_JSX_RUNTIME = 'https://esm.sh/react@19.0.0/jsx-dev-runtime?dev'

export interface DevAssetsOptions {
  /** Absolute path to the resources directory (e.g. `/app/resources`). */
  resourcesDir?: string
  /** Base import meta used to resolve relative paths. */
  importMeta?: ImportMeta
  /** Relative path from `importMeta` to the resources directory. Defaults to `../resources`. */
  resourcesPath?: string
  /** Path prefix to mount transpiled JS assets. Defaults to `/resources/js`. */
  prefix?: string
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
}

// get the path to the inertia client bundled with Guren
const require = createRequire(import.meta.url)
const gurenInertiaClient = require.resolve('@guren/inertia-client/app')

/**
 * Registers development asset serving middleware.
 * @param app
 * @param options 
 */
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
  const inertiaClientPath = options.inertiaClientPath ?? DEFAULT_VENDOR_PATH
  const inertiaClientSource = options.inertiaClientSource ?? gurenInertiaClient
  const jsxRuntimeUrl = options.jsxRuntimeUrl ?? DEFAULT_JSX_RUNTIME

  const resourcesJsDir = resolve(resourcesDir, 'js')
  const reactImportPattern = /from\s+['"]react['"]/u

  const transpilerOptions = {
    target: 'browser' as const,
    jsx: 'transform' as const,
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
    },
  }

  const tsxTranspiler = new Bun.Transpiler({ loader: 'tsx', ...transpilerOptions })
  const tsTranspiler = new Bun.Transpiler({ loader: 'ts', ...transpilerOptions })

  app.hono.get(`${prefix}/*`, (ctx) => handleTranspileRequest(ctx, resourcesJsDir, prefix, reactImportPattern, tsxTranspiler, tsTranspiler, jsxRuntimeUrl))

  if (options.inertiaClient !== false) {
    const inertiaClientDir = dirname(inertiaClientSource)
    const inertiaClientBase = inertiaClientPath.replace(/[^/]*$/u, '') || '/'
    const inertiaClientPattern = `${inertiaClientBase.endsWith('/') ? inertiaClientBase : `${inertiaClientBase}/`}*`
    const inertiaClientRequestPath = inertiaClientPath.slice(inertiaClientBase.length)

    app.hono.get(inertiaClientPattern, (ctx) => {
      const relativeRequest = ctx.req.path.slice(inertiaClientBase.length) || inertiaClientRequestPath

      if (relativeRequest === inertiaClientRequestPath) {
        return transpileFile(inertiaClientSource, reactImportPattern, tsxTranspiler, tsTranspiler, jsxRuntimeUrl)
      }

      const candidatePath = resolve(inertiaClientDir, relativeRequest)

      if (!candidatePath.startsWith(inertiaClientDir)) {
        return ctx.notFound()
      }

      return transpileFile(candidatePath, reactImportPattern, tsxTranspiler, tsTranspiler, jsxRuntimeUrl)
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
      }),
    )

    if (options.favicon !== false) {
      app.hono.get('/favicon.ico', () => new Response(null, { status: 204 }))
    }
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

/**
 * Handles a request to transpile a JavaScript or TypeScript file.
 * @param ctx The request context.
 * @param resourcesJsDir The directory containing the resource files.
 * @param prefix The URL prefix for the request.
 * @param reactImportPattern The regex pattern for detecting React imports.
 * @param tsxTranspiler The transpiler for TSX files.
 * @param tsTranspiler The transpiler for TS files.
 * @param jsxRuntimeUrl The URL for the JSX runtime.
 * @returns A Promise that resolves to a Response object.
 */
async function handleTranspileRequest(
  ctx: Context,
  resourcesJsDir: string,
  prefix: string,
  reactImportPattern: RegExp,
  tsxTranspiler: any,
  tsTranspiler: any,
  jsxRuntimeUrl: string,
): Promise<Response> {
  const relative = ctx.req.path.slice(prefix.length + 1)
  const fsPath = resolve(resourcesJsDir, relative)

  if (!fsPath.startsWith(resourcesJsDir)) {
    return ctx.notFound()
  }

  return transpileFile(fsPath, reactImportPattern, tsxTranspiler, tsTranspiler, jsxRuntimeUrl)
}

/**
 * Transpiles a file if it's a TSX or TS file, otherwise serves it as a static asset.
 * @param fsPath The file system path to the file.
 * @param reactImportPattern The regex pattern for detecting React imports.
 * @param tsxTranspiler The transpiler for TSX files.
 * @param tsTranspiler The transpiler for TS files.
 * @param jsxRuntimeUrl The URL for the JSX runtime.
 * @returns A Promise that resolves to a Response object.
 */
async function transpileFile(
  fsPath: string,
  reactImportPattern: RegExp,
  tsxTranspiler: any,
  tsTranspiler: any,
  jsxRuntimeUrl: string,
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

  const ext = extname(filePath)
  let source = await file.text()

  if (ext === '.tsx' && !reactImportPattern.test(source)) {
    source = "import React from 'react'\n" + source
  }

  if (ext === '.tsx' || ext === '.ts') {
    const transpiled =
      ext === '.tsx'
        ? tsxTranspiler.transformSync(source, {
          loader: 'tsx',
          sourceMap: isDev() ? 'inline' : false,
          filename: filePath,
        })
        : tsTranspiler.transformSync(source, {
          loader: 'ts',
          sourceMap: isDev() ? 'inline' : false,
          filename: filePath,
        })

    const helpers = collectJsxHelpers(transpiled)
    const runtimeShim = helpers.size ? createJsxRuntimeShim(helpers, jsxRuntimeUrl) : ''

    return new Response(runtimeShim + transpiled, {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': isDev() ? 'no-cache' : 'public, max-age=31536000',
      },
    })
  }

  const body = await file.arrayBuffer()
  return new Response(body, {
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'Cache-Control': isDev() ? 'no-cache' : 'public, max-age=31536000',
    },
  })
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
  return (process.env.NODE_ENV ?? 'development') !== 'production'
}
