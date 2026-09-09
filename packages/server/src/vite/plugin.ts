import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface GurenVitePluginOptions {
  /** Alias prefix for application imports such as `@/.guren/routes.gen` (defaults to `@`). */
  appAlias?: string
  /** Directory the alias resolves to, relative to the project root (defaults to `.`, the project root). */
  appDir?: string
  /** Alias for the frontend resources directory (defaults to `@resources`). */
  resourcesAlias?: string
  /** Relative path to the frontend resources directory (defaults to `resources/js`). */
  resourcesDir?: string
  /** Path to the primary frontend entry file (defaults to `resources/js/app.tsx`). */
  entry?: string
  /** Path to the SSR entry file (defaults to `resources/js/ssr.tsx`). */
  ssrEntry?: string
  /** Output directory for compiled assets (defaults to `public/assets`). */
  outDir?: string
  /** Output directory for SSR bundles (defaults to `.guren/ssr`). */
  ssrOutDir?: string
  /** Default dev server port (defaults to 5173). */
  devPort?: number
  /** Default preview server port (defaults to 4173). */
  previewPort?: number
  /** Rollup naming pattern for entry chunks (defaults to `[name]-[hash].js`). */
  entryFileNames?: string
  /** Rollup naming pattern for dynamic chunks (defaults to `[name]-[hash].js`). */
  chunkFileNames?: string
  /** Rollup naming pattern for extracted assets (defaults to `[name]-[hash][extname]`). */
  assetFileNames?: string
  /** Prototype mode (`vite --mode prototype`, RFC 0021): the static, server-less build. */
  prototype?: GurenPrototypeOptions
}

export interface GurenPrototypeOptions {
  /** Vite `base` for a build hosted under a subpath (a GitHub project page, a preview URL). Defaults to `/`. */
  base?: string
  /** Output directory (defaults to `dist/prototype`). */
  outDir?: string
  /**
   * The HTML shell, relative to the project root. Defaults to
   * `resources/js/prototype/index.html` when that file exists, else a
   * generated shell under `.guren/prototype/`.
   */
  shell?: string
}

/** Where the generated shell goes; `.guren/` is already gitignored and codegen-owned. */
export const PROTOTYPE_SHELL_FILE = '.guren/prototype/index.html'
/** The override a project may ship instead of the generated shell. */
export const PROTOTYPE_SHELL_OVERRIDE = 'resources/js/prototype/index.html'
export const PROTOTYPE_MODE = 'prototype'

/** Every option defaulted except `prototype`, which is absent for the ordinary build. */
type ResolvedOptions = Required<Omit<GurenVitePluginOptions, 'prototype'>> & Pick<GurenVitePluginOptions, 'prototype'>

const defaultOptions: ResolvedOptions = {
  appAlias: '@',
  appDir: '.',
  resourcesAlias: '@resources',
  resourcesDir: 'resources/js',
  entry: 'resources/js/app.tsx',
  ssrEntry: 'resources/js/ssr.tsx',
  outDir: 'public/assets',
  ssrOutDir: '.guren/ssr',
  devPort: 5173,
  previewPort: 4173,
  entryFileNames: '[name]-[hash].js',
  chunkFileNames: '[name]-[hash].js',
  assetFileNames: '[name]-[hash][extname]',
}

export function gurenVitePlugin(options: GurenVitePluginOptions = {}) {
  const resolved = { ...defaultOptions, ...options }
  let prototype: ResolvedPrototype | undefined

  return {
    name: 'guren:vite-config',
    enforce: 'pre' as const,
    config(config: Record<string, any>, env: Record<string, any>) {
      if (env?.mode === PROTOTYPE_MODE) {
        prototype = ensurePrototype(config, resolved)
        return
      }
      prototype = undefined
      ensureDefaults(config, resolved, env)
    },
    configResolved(config: Record<string, any>) {
      if (prototype) {
        prototype.outDir = path.resolve(config.root ?? prototype.root, config.build?.outDir ?? prototype.outDir)
      }
    },
    configureServer(server: ViteDevServerLike) {
      if (!prototype) return
      const shellPath = prototype.shellPath
      // Vite's own SPA fallback only serves a root `index.html`, which a Guren
      // app has no reason to keep; with `appType: 'custom'` this answers every
      // document request with the shell instead.
      return () => {
        server.middlewares.use(async (req, res, next) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return next()
          if (!String(req.headers.accept ?? '').includes('text/html')) return next()
          const url = req.url ?? '/'
          if (/\.[a-z0-9]+$/iu.test(url.split('?')[0] ?? '')) return next()
          try {
            const html = await server.transformIndexHtml(url, readFileSync(shellPath, 'utf8'), req.originalUrl)
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(html)
          } catch (error) {
            next(error)
          }
        })
      }
    },
    writeBundle() {
      if (prototype) finishPrototypeBuild(prototype)
    },
  }
}

interface ResolvedPrototype {
  root: string
  /** As configured until `configResolved` rewrites it to the absolute directory the build wrote to. */
  outDir: string
  shellPath: string
  /** The ordinary build's output, relative to `publicDir`, when it lives inside it; copied along with `public/` and removed again. */
  copiedBuildDir?: string
}

interface ViteDevServerLike {
  middlewares: {
    use(handler: (req: IncomingLike, res: ResponseLike, next: (error?: unknown) => void) => void): void
  }
  transformIndexHtml(url: string, html: string, originalUrl?: string): Promise<string>
}

interface IncomingLike {
  method?: string
  url?: string
  originalUrl?: string
  headers: Record<string, string | string[] | undefined>
}

interface ResponseLike {
  setHeader(name: string, value: string): void
  end(body: string): void
}

/**
 * The prototype branch, taken before the ordinary client defaults so none of
 * `ensureBuild`'s outDir/base/publicDir reasoning applies: there is no server
 * to serve `public/`, no manifest to read, and the entry is an HTML shell.
 */
function ensurePrototype(config: Record<string, any>, options: ResolvedOptions): ResolvedPrototype {
  const root = resolveRoot(config.root)
  const prototype = options.prototype ?? {}

  ensureAliases(config, options, root)
  ensureServer(config, options)
  ensurePreview(config, options)

  config.define ??= {}
  config.define['import.meta.env.GUREN_PROTOTYPE'] ??= 'true'
  // The dev shell comes from configureServer; Vite's spa handling would look
  // for a root index.html and 404.
  config.appType ??= 'custom'
  config.base ??= prototype.base ?? '/'

  // The default template sets `publicDir: false` because the ordinary build
  // emits into `public/`; that reason is gone here, so `false` is replaced and
  // only a custom directory is kept.
  if (typeof config.publicDir !== 'string') {
    config.publicDir = path.resolve(root, 'public')
  }
  // The scaffold's ordinary build emits into `public/assets/`, so copying
  // `public/` would ship the production bundle beside the prototype's.
  const publicDir = path.resolve(root, config.publicDir)
  const buildOutDir = resolveBuildOutputDirectory(root, options.outDir)
  const copiedBuildDir = path.relative(publicDir, buildOutDir)
  const copiesBuild = copiedBuildDir !== '' && !copiedBuildDir.startsWith('..') && !path.isAbsolute(copiedBuildDir)

  config.build ??= {}
  config.build.outDir ??= prototype.outDir ?? 'dist/prototype'
  config.build.emptyOutDir ??= true
  config.build.copyPublicDir = true
  config.build.manifest ??= false
  config.build.ssrManifest ??= false

  const shellPath = resolvePrototypeShell(root, prototype.shell, options.entry)
  config.build.rollupOptions ??= {}
  config.build.rollupOptions.input ??= shellPath

  const output = normalizeRollupOutput(config.build.rollupOptions.output)
  output.entryFileNames ??= options.entryFileNames
  output.chunkFileNames ??= options.chunkFileNames
  output.assetFileNames ??= options.assetFileNames
  output.manualChunks ??= createDefaultManualChunks(root)
  config.build.rollupOptions.output = output

  return { root, outDir: config.build.outDir, shellPath, ...(copiesBuild ? { copiedBuildDir } : {}) }
}

function resolvePrototypeShell(root: string, shell: string | undefined, entry: string): string {
  if (shell) return path.resolve(root, shell)

  const override = path.resolve(root, PROTOTYPE_SHELL_OVERRIDE)
  if (existsSync(override)) return override

  const generated = path.resolve(root, PROTOTYPE_SHELL_FILE)
  const contents = renderPrototypeShell(entry)
  // Written from config() rather than a build hook so the dev server has it
  // too; skipped when unchanged so a watcher does not see a write per start.
  if (readShell(generated) !== contents) {
    mkdirSync(path.dirname(generated), { recursive: true })
    writeFileSync(generated, contents)
  }
  return generated
}

/** The shell on disk, or null when there is none; read directly so no check-then-read window exists. */
function readShell(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function renderPrototypeShell(entry: string): string {
  const src = `/${entry.replace(/^\.?\//u, '')}`
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Prototype</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="${src}"></script>
  </body>
</html>
`
}

/**
 * Vite emits an HTML input at its path relative to the root, so the shell
 * lands nested; move it to the top, then add the SPA fallbacks: `404.html`
 * (GitHub Pages) and `_redirects` (Netlify, Cloudflare Pages).
 */
function finishPrototypeBuild(prototype: ResolvedPrototype): void {
  const relative = path.relative(prototype.root, prototype.shellPath)
  const outDir = path.resolve(prototype.root, prototype.outDir)
  const nested = path.resolve(outDir, relative)
  const top = path.resolve(outDir, 'index.html')

  if (nested !== top && existsSync(nested)) {
    renameSync(nested, top)
    const topLevelDir = relative.split(path.sep)[0]
    if (topLevelDir && topLevelDir !== '.' && topLevelDir !== '..') {
      rmSync(path.resolve(outDir, topLevelDir), { recursive: true, force: true })
    }
  }

  if (!existsSync(top)) {
    throw new Error(`Prototype build produced no index.html in ${outDir}`)
  }

  if (prototype.copiedBuildDir) {
    rmSync(path.resolve(outDir, prototype.copiedBuildDir), { recursive: true, force: true })
  }
  writeFileSync(path.resolve(outDir, '404.html'), readFileSync(top))
  writeFileSync(path.resolve(outDir, '_redirects'), '/*    /index.html   200\n')
}

export default gurenVitePlugin

function ensureDefaults(config: Record<string, any>, options: ResolvedOptions, env: Record<string, any>) {
  const root = resolveRoot(config.root)

  // A literal in every mode, so `import.meta.env.GUREN_PROTOTYPE ? … : undefined`
  // is dead code outside prototype mode and its dynamic import never becomes a
  // build dependency.
  config.define ??= {}
  config.define['import.meta.env.GUREN_PROTOTYPE'] ??= 'false'

  ensureAliases(config, options, root)
  ensureServer(config, options)
  ensurePreview(config, options)
  ensureBuild(config, options, root, env)
}

function ensureAliases(config: Record<string, any>, options: ResolvedOptions, root: string) {
  config.resolve ??= {}
  const alias = toAliasArray(config.resolve.alias)

  maybePushAlias(alias, options.appAlias, path.resolve(root, options.appDir))
  maybePushAlias(alias, options.resourcesAlias, path.resolve(root, options.resourcesDir))

  config.resolve.alias = alias
}

function ensureServer(config: Record<string, any>, options: ResolvedOptions) {
  config.server ??= {}

  // `server.host` is left alone so Vite's localhost-only default applies: the
  // dev server serves any file under the project root — including the default
  // SQLite database at `data/guren.db`, which `server.fs.deny` does not cover —
  // with no auth or origin check. LAN exposure stays an explicit `--host`.
  if (config.server.port === undefined) {
    config.server.port = options.devPort
  }
}

function ensurePreview(config: Record<string, any>, options: ResolvedOptions) {
  config.preview ??= {}

  // Preview serves only `build.outDir`, never the project root, so binding
  // every interface exposes assets that are about to ship publicly anyway —
  // kept on for checking a production build from a phone on the same network.
  if (config.preview.host === undefined) {
    config.preview.host = true
  }

  if (config.preview.port === undefined) {
    config.preview.port = options.previewPort
  }
}

function ensureBuild(
  config: Record<string, any>,
  options: ResolvedOptions,
  root: string,
  env: Record<string, any>,
) {
  config.build ??= {}
  const isSsrBuild = Boolean(env?.ssrBuild ?? env?.isSsrBuild)
  const isServeCommand = env?.command === 'serve'

  if (config.build.emptyOutDir === undefined) {
    config.build.emptyOutDir = true
  }

  if (isSsrBuild) {
    // Bundle all dependencies into the SSR output so `.guren/ssr` stays
    // importable on serverless runtimes that ship without node_modules.
    config.ssr ??= {}
    if (config.ssr.noExternal === undefined) {
      config.ssr.noExternal = true
    }

    if (config.build.outDir === undefined) {
      config.build.outDir = options.ssrOutDir
    }

    if (config.build.manifest === undefined) {
      config.build.manifest = true
    }

    if (config.build.ssr === undefined) {
      config.build.ssr = path.resolve(root, options.ssrEntry)
    }

    config.build.rollupOptions ??= {}
    config.build.rollupOptions.input = path.resolve(root, options.ssrEntry)
  } else {
    if (config.build.outDir === undefined) {
      config.build.outDir = options.outDir
    }

    if (config.build.manifest === undefined) {
      config.build.manifest = true
    }

    if (config.build.ssrManifest === undefined) {
      config.build.ssrManifest = true
    }

    if (!isServeCommand && config.base === undefined) {
      const derivedBase = deriveHttpBaseFromOutDir(options.outDir)

      if (derivedBase) {
        config.base = derivedBase
      }
    }

    const buildOutDir = resolveBuildOutputDirectory(root, config.build.outDir)
    const rootPublicDir = path.resolve(root, 'public')

    if (buildOutDir.startsWith(rootPublicDir)) {
      if (config.build.copyPublicDir === undefined) {
        config.build.copyPublicDir = false
      }

      if (config.publicDir === undefined) {
        config.publicDir = false
      }
    }
  }

  config.build.rollupOptions ??= {}

  if (!isSsrBuild && config.build.rollupOptions.input === undefined) {
    config.build.rollupOptions.input = path.resolve(root, options.entry)
  }

  const output = normalizeRollupOutput(config.build.rollupOptions.output)

  if (output.entryFileNames === undefined) {
    output.entryFileNames = options.entryFileNames
  }

  if (output.chunkFileNames === undefined) {
    output.chunkFileNames = options.chunkFileNames
  }

  if (output.assetFileNames === undefined) {
    output.assetFileNames = options.assetFileNames
  }

  if (!isSsrBuild && output.manualChunks === undefined) {
    output.manualChunks = createDefaultManualChunks(root)
  }

  config.build.rollupOptions.output = output
}

/** `@guren/inertia-client`'s prototype entry (src or dist) and the Hono router it alone imports. */
const PROTOTYPE_RUNTIME_MODULE = /\/inertia-client\/(?:src|dist)\/prototype(?:-[^/]+)?\.[jt]sx?$|\/node_modules\/hono\/dist\/router\//u

function createDefaultManualChunks(root: string) {
  const normalizedRoot = root.replace(/\\/gu, '/')

  return (id: string): string | undefined => {
    const normalizedId = id.replace(/\\/gu, '/')

    // Reached only through startInertiaClient()'s dynamic import; naming a
    // vendor chunk for it would splice it into the eagerly loaded one, and the
    // production bundle would carry the prototype runtime and Hono's router.
    if (PROTOTYPE_RUNTIME_MODULE.test(normalizedId)) {
      return undefined
    }

    if (normalizedId.includes('/packages/inertia-client/')) {
      return 'inertia-vendor'
    }

    if (normalizedId.includes('/packages/core/') || normalizedId.includes('/packages/server/') || normalizedId.includes('/packages/orm/')) {
      return 'framework-vendor'
    }

    if (!normalizedId.includes('/node_modules/')) {
      if (normalizedId.startsWith(normalizedRoot)) {
        return undefined
      }

      if (normalizedId.includes('/packages/')) {
        return 'framework-vendor'
      }

      return undefined
    }

    if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/u.test(normalizedId)) {
      return 'react-vendor'
    }

    if (
      /[\\/]node_modules[\\/]@inertiajs[\\/]/u.test(normalizedId) ||
      /[\\/]node_modules[\\/](axios|qs|lodash-es|lodash)[\\/]/u.test(normalizedId)
    ) {
      return 'inertia-vendor'
    }

    if (/[\\/]node_modules[\\/](@guren|hono)[\\/]/u.test(normalizedId)) {
      return 'framework-vendor'
    }

    return 'vendor'
  }
}

function resolveBuildOutputDirectory(root: string, outDir: string): string {
  return path.isAbsolute(outDir) ? outDir : path.resolve(root, outDir)
}

function deriveHttpBaseFromOutDir(outDir: string): string | undefined {
  const normalized = outDir.replace(/\\/gu, '/').replace(/^\.\//u, '')

  if (normalized === 'public') {
    return '/public/'
  }

  if (normalized.startsWith('public/')) {
    const remainder = normalized.slice('public/'.length)
    const suffix = remainder.length > 0 ? `${remainder.replace(/\/$/u, '')}/` : ''
    return `/public/${suffix}`
  }

  return undefined
}

function resolveRoot(root: string | undefined): string {
  if (!root) {
    return process.cwd()
  }

  return path.isAbsolute(root) ? root : path.resolve(process.cwd(), root)
}

function toAliasArray(alias: AliasOptions): AliasEntry[] {
  if (Array.isArray(alias)) {
    return alias.slice()
  }

  if (alias && typeof alias === 'object') {
    return Object.entries(alias).map(([find, replacement]) => ({
      find,
      replacement: replacement as string,
    }))
  }

  return []
}

function maybePushAlias(alias: AliasEntry[], find: string, replacement: string) {
  const alreadyDefined = alias.some((entry) => entry.find === find)

  if (!alreadyDefined) {
    alias.push({ find, replacement })
  }
}

function normalizeRollupOutput(output: unknown): Record<string, any> {
  if (Array.isArray(output)) {
    if (output.length === 0) {
      return {}
    }

    return output[0] as Record<string, any>
  }

  return (output ?? {}) as Record<string, any>
}

type AliasEntry = { find: string | RegExp; replacement: string }
type AliasOptions = AliasEntry[] | Record<string, string> | undefined
