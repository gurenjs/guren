import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { definePlugin, type ServiceProviderConstructor } from '@guren/core'

type PathLike = string | URL

type ManifestEntry = {
  file?: string
  css?: string[]
}

type Manifest = Record<string, ManifestEntry>

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

  if (existsSync(out)) {
    rmSync(out, { recursive: true, force: true })
  }

  mkdirSync(funcDir, { recursive: true })
  mkdirSync(resolve(out, 'static'), { recursive: true })

  const env = buildVercelEnvironment(root)

  writeFileSync(
    resolve(out, 'config.json'),
    JSON.stringify(
      {
        version: 3,
        routes: [
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
    cmd: [
      'bun',
      'build',
      entrypoint,
      '--outdir',
      funcDir,
      '--target',
      'bun',
      '--minify',
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

function buildVercelEnvironment(root: string): Record<string, string> {
  const env: Record<string, string> = {
    NODE_ENV: 'production',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '/tmp/.bun-cache',
    BUN_INSTALL_CACHE_DIR: '/tmp/.bun-install-cache',
    TMPDIR: '/tmp',
  }

  const clientManifest = loadManifest(
    resolve(root, 'public/assets/.vite/manifest.json'),
    resolve(root, 'public/assets/manifest.json'),
  )

  if (clientManifest) {
    const entry = clientManifest['resources/js/app.tsx']
    if (entry?.file) {
      env.GUREN_INERTIA_ENTRY = `/assets/${entry.file}`
    }
    if (entry?.css?.length) {
      env.GUREN_INERTIA_STYLES = entry.css.map((file) => `/assets/${file}`).join(',')
    }
  }

  const ssrManifest = loadManifest(
    resolve(root, '.guren/ssr/.vite/manifest.json'),
    resolve(root, '.guren/ssr/manifest.json'),
  )

  if (ssrManifest) {
    const ssrEntry = ssrManifest['resources/js/ssr.tsx']
    if (ssrEntry?.file) {
      env.GUREN_INERTIA_SSR_ENTRY = `./.guren/ssr/${ssrEntry.file}`
    }
    env.GUREN_INERTIA_SSR_MANIFEST = './.guren/ssr/.vite/manifest.json'
  }

  env.GUREN_INERTIA_IMPORT_MAP = JSON.stringify({
    '@guren/inertia-client': '/vendor/inertia-client.tsx',
  })

  return env
}

function resolvePathLike(value: PathLike): string {
  return value instanceof URL ? fileURLToPath(value) : resolve(String(value))
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

function loadManifest(...paths: string[]): Manifest | undefined {
  for (const path of paths) {
    if (!existsSync(path)) {
      continue
    }

    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Manifest
    } catch {
      continue
    }
  }

  return undefined
}
