import path from 'node:path'

export interface GurenVitePluginOptions {
  /** Alias for the application directory (defaults to `@`). */
  appAlias?: string
  /** Relative path to the application directory (defaults to `app`). */
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
}

const defaultOptions: Required<GurenVitePluginOptions> = {
  appAlias: '@',
  appDir: 'app',
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

  return {
    name: 'guren:vite-config',
    enforce: 'pre' as const,
    config(config: Record<string, any>, env: Record<string, any>) {
      ensureDefaults(config, resolved, env)
    },
  }
}

export default gurenVitePlugin

function ensureDefaults(config: Record<string, any>, options: Required<GurenVitePluginOptions>, env: Record<string, any>) {
  const root = resolveRoot(config.root)

  ensureAliases(config, options, root)
  ensureServer(config, options)
  ensurePreview(config, options)
  ensureBuild(config, options, root, env)
}

function ensureAliases(config: Record<string, any>, options: Required<GurenVitePluginOptions>, root: string) {
  config.resolve ??= {}
  const alias = toAliasArray(config.resolve.alias)

  maybePushAlias(alias, options.appAlias, path.resolve(root, options.appDir))
  maybePushAlias(alias, options.resourcesAlias, path.resolve(root, options.resourcesDir))

  config.resolve.alias = alias
}

function ensureServer(config: Record<string, any>, options: Required<GurenVitePluginOptions>) {
  config.server ??= {}

  if (config.server.host === undefined) {
    config.server.host = true
  }

  if (config.server.port === undefined) {
    config.server.port = options.devPort
  }
}

function ensurePreview(config: Record<string, any>, options: Required<GurenVitePluginOptions>) {
  config.preview ??= {}

  if (config.preview.host === undefined) {
    config.preview.host = true
  }

  if (config.preview.port === undefined) {
    config.preview.port = options.previewPort
  }
}

function ensureBuild(
  config: Record<string, any>,
  options: Required<GurenVitePluginOptions>,
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

  config.build.rollupOptions.output = output
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
