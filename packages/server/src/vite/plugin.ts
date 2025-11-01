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
  /** Output directory for compiled assets (defaults to `public/assets`). */
  outDir?: string
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
  outDir: 'public/assets',
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
    config(config: Record<string, any>, _env: Record<string, any>) {
      ensureDefaults(config, resolved)
    },
  }
}

export default gurenVitePlugin

function ensureDefaults(config: Record<string, any>, options: Required<GurenVitePluginOptions>) {
  const root = resolveRoot(config.root)

  ensureAliases(config, options, root)
  ensureServer(config, options)
  ensurePreview(config, options)
  ensureBuild(config, options, root)
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

function ensureBuild(config: Record<string, any>, options: Required<GurenVitePluginOptions>, root: string) {
  config.build ??= {}

  if (config.build.outDir === undefined) {
    config.build.outDir = options.outDir
  }

  if (config.build.emptyOutDir === undefined) {
    config.build.emptyOutDir = true
  }

  if (config.build.manifest === undefined) {
    config.build.manifest = true
  }

  config.build.rollupOptions ??= {}

  if (config.build.rollupOptions.input === undefined) {
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
