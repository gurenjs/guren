import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, relative, resolve, sep } from 'node:path'
import { definePlugin, type ServiceProviderConstructor } from '@guren/core'
import {
  resetOutputDir,
  resolveClientAssetEnv,
  resolvePathLike,
  resolveSsrEntryFile,
  ssrManifestRelativePath,
  type PathLike,
} from '@guren/core/internal/deploy-build'

/** Prefixes every diagnostic this build emits. */
const LABEL = 'Vercel build'

export interface VercelAppLike {
  boot(): Promise<void>
  fetch(request: Request): Response | Promise<Response>
}

export interface VercelHandler {
  fetch(request: Request): Response | Promise<Response>
}

export interface BuildVercelOutputOptions {
  rootDir?: PathLike
  entrypoint?: PathLike
  outputDir?: PathLike
  publicDir?: PathLike
  docsDir?: PathLike
  ssrDir?: PathLike
  migrationsDir?: PathLike
}

/**
 * Configuration for the Vercel plugin. Currently empty — reserved so future
 * fields never force another registration-shape change.
 */
export interface VercelPluginConfig {}

const factory = definePlugin<VercelPluginConfig>({
  name: 'vercel',
  register() {},
})

/**
 * Register the Vercel plugin.
 *
 * @example
 * ```typescript
 * createApp({ providers: [vercelPlugin()] })
 * ```
 */
export function vercelPlugin(config: VercelPluginConfig = {}): ServiceProviderConstructor {
  return factory(config)
}

export async function createVercelHandler(app: VercelAppLike): Promise<VercelHandler> {
  await app.boot()
  return {
    fetch(request: Request) {
      return app.fetch(request)
    },
  }
}

export function buildVercelOutput(options: BuildVercelOutputOptions = {}): void {
  const root = resolvePathLike(options.rootDir ?? new URL('..', import.meta.url))
  const out = resolvePathLike(options.outputDir ?? resolve(root, '.vercel/output'))
  const funcDir = resolve(out, 'functions/index.func')
  const entrypoint = resolvePathLike(options.entrypoint ?? resolve(root, 'src/vercel.ts'))
  const handler = `${basename(entrypoint, extname(entrypoint))}.js`
  const publicDir = resolvePathLike(options.publicDir ?? resolve(root, 'public'))
  const docsDir = resolvePathLike(options.docsDir ?? resolveNearestDocsDir(root) ?? resolve(root, 'docs'))
  const ssrDir = resolvePathLike(options.ssrDir ?? resolve(root, '.guren/ssr'))
  const migrationsDir = resolvePathLike(options.migrationsDir ?? resolve(root, 'db/migrations'))

  resetOutputDir(out, root, LABEL)

  mkdirSync(funcDir, { recursive: true })
  mkdirSync(resolve(out, 'static'), { recursive: true })

  const env = buildVercelEnvironment(publicDir, ssrDir)

  writeFileSync(
    resolve(out, 'config.json'),
    JSON.stringify(
      {
        version: 3,
        routes: [
          // Built assets self-reference the Vite plugin's derived base,
          // `/public/assets/`, while the files themselves are copied to the
          // output root. Without this the entry script still loads — its path
          // is injected directly — but every chunk it imports falls through
          // to the function and comes back as HTML.
          //
          // A `rewrites` entry in vercel.json only covers builds Vercel runs
          // itself; a `--prebuilt` upload is routed by this file alone, which
          // is the flow the deployment guide documents.
          { src: '/public/(.*)', dest: '/$1' },
          { handle: 'filesystem' },
          { src: '/(.*)', dest: '/index' },
        ],
      },
      null,
      2,
    ),
  )

  writeFileSync(
    resolve(funcDir, '.vc-config.json'),
    JSON.stringify(
      {
        handler,
        runtime: 'bun1.x',
        launcherType: 'Nodejs',
        shouldAddHelpers: true,
        environment: env,
      },
      null,
      2,
    ),
  )

  const result = Bun.spawnSync({
    // `bun build` inlines `process.env.NODE_ENV` at bundle time (defaulting to
    // "development"), so pin it to "production" for the deployed function.
    //
    // Whitespace and syntax only — never plain `--minify`, which also mangles
    // identifiers. Guren keys durable records on class names: the queue
    // registry stores each job's wire name (its class name unless it declares a
    // jobName) in every queued message, and notifications persist
    // `constructor.name` as their `type`. Mangled, a job dispatched by one
    // deploy resolves to nothing after the next.
    //
    // Not `--keep-names`: as of Bun 1.3.14 it is accepted and silently leaves
    // class names mangled, so it cannot replace this.
    cmd: [
      'bun',
      'build',
      entrypoint,
      '--outdir',
      funcDir,
      '--target',
      'bun',
      '--minify-whitespace',
      '--minify-syntax',
      '--define',
      'process.env.NODE_ENV="production"',
    ],
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  if (result.exitCode !== 0) {
    throw new Error('bun build failed')
  }

  if (existsSync(ssrDir)) {
    cpSync(ssrDir, resolve(funcDir, '.guren/ssr'), { recursive: true })
  }

  if (existsSync(migrationsDir)) {
    cpSync(migrationsDir, resolve(funcDir, 'db/migrations'), { recursive: true })
  }

  if (existsSync(docsDir)) {
    cpSync(docsDir, resolve(funcDir, 'docs'), { recursive: true })
  }

  if (existsSync(publicDir)) {
    cpSync(publicDir, resolve(out, 'static'), { recursive: true })
  }
}

function buildVercelEnvironment(publicDir: string, ssrDir: string): Record<string, string> {
  const env: Record<string, string> = {
    NODE_ENV: 'production',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '/tmp/.bun-cache',
    BUN_INSTALL_CACHE_DIR: '/tmp/.bun-install-cache',
    TMPDIR: '/tmp',
  }

  const assetEnv = resolveClientAssetEnv(publicDir, 'resources/js/app.tsx', LABEL)
  if (assetEnv.entry) {
    env.GUREN_INERTIA_ENTRY = assetEnv.entry
  }
  if (assetEnv.styles) {
    env.GUREN_INERTIA_STYLES = assetEnv.styles
  }

  const ssrFile = resolveSsrEntryFile(ssrDir, 'resources/js/ssr.tsx', LABEL)
  if (ssrFile) {
    // Relative specifiers resolve from the function root, where the SSR bundle
    // is copied.
    env.GUREN_INERTIA_SSR_ENTRY = `./.guren/ssr/${relative(ssrDir, ssrFile).split(sep).join('/')}`
    env.GUREN_INERTIA_SSR_MANIFEST = ssrManifestRelativePath(ssrDir, './.guren/ssr')
  }

  env.GUREN_INERTIA_IMPORT_MAP = JSON.stringify({
    '@guren/inertia-client': '/vendor/inertia-client.tsx',
  })

  return env
}

function resolveNearestDocsDir(startDir: string, maxDepth = 6): string | undefined {
  let currentDir = startDir

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const candidate = resolve(currentDir, 'docs')
    if (existsSync(candidate)) {
      return candidate
    }

    const parent = resolve(currentDir, '..')
    if (parent === currentDir) {
      break
    }
    currentDir = parent
  }

  return undefined
}

