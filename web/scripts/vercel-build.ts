/**
 * Assemble Vercel Build Output API structure.
 *
 * Uses `bun build` to bundle the server entrypoint into a single file,
 * avoiding circular workspace symlink issues with file copying.
 * Reads Vite manifests and injects Inertia env vars into .vc-config.json.
 */
import { cpSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '.vercel/output')
const funcDir = resolve(out, 'functions/index.func')

// Clean previous output
if (existsSync(out)) {
  rmSync(out, { recursive: true })
}

mkdirSync(funcDir, { recursive: true })
mkdirSync(resolve(out, 'static'), { recursive: true })

// --- Read Vite manifests to derive Inertia env vars ---

type ManifestEntry = { file?: string; css?: string[] }
type Manifest = Record<string, ManifestEntry>

function loadManifest(...paths: string[]): Manifest | undefined {
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as Manifest
    } catch {
      continue
    }
  }
  return undefined
}

const env: Record<string, string> = {
  NODE_ENV: 'production',
}

// Client manifest → entry script + CSS
const clientManifest = loadManifest(
  resolve(root, 'public/assets/.vite/manifest.json'),
)
if (clientManifest) {
  const entry = clientManifest['resources/js/app.tsx']
  if (entry?.file) {
    env.GUREN_INERTIA_ENTRY = `/assets/${entry.file}`
  }
  if (entry?.css?.length) {
    env.GUREN_INERTIA_STYLES = entry.css.map((f) => `/assets/${f}`).join(',')
  }
}

// SSR manifest → SSR entry path (relative to function dir at runtime)
const ssrManifest = loadManifest(
  resolve(root, '.guren/ssr/.vite/manifest.json'),
)
if (ssrManifest) {
  const ssrEntry = ssrManifest['resources/js/ssr.tsx']
  if (ssrEntry?.file) {
    // At runtime the function runs from /var/task/, SSR bundle is at /var/task/.guren/ssr/
    env.GUREN_INERTIA_SSR_ENTRY = `./.guren/ssr/${ssrEntry.file}`
  }
  env.GUREN_INERTIA_SSR_MANIFEST = './.guren/ssr/.vite/manifest.json'
}

env.GUREN_INERTIA_IMPORT_MAP = JSON.stringify({
  '@guren/inertia-client': '/vendor/inertia-client.tsx',
})

// Bun needs writable dirs for cache on Vercel's read-only filesystem
env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = '/tmp/.bun-cache'
env.BUN_INSTALL_CACHE_DIR = '/tmp/.bun-install-cache'
env.TMPDIR = '/tmp'

// 1. Vercel routing config
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

// 2. Function config with Inertia env vars
writeFileSync(
  resolve(funcDir, '.vc-config.json'),
  JSON.stringify(
    {
      handler: 'index.js',
      runtime: 'bun1.x',
      launcherType: 'Nodejs',
      shouldAddHelpers: true,
      environment: env,
    },
    null,
    2,
  ),
)

// 3. Bundle server entrypoint with bun build
const entrypoint = resolve(root, 'src/index.ts')
const result = Bun.spawnSync({
  cmd: ['bun', 'build', entrypoint, '--outdir', funcDir, '--target', 'bun', '--minify'],
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
})

if (result.exitCode !== 0) {
  console.error('bun build failed')
  process.exit(1)
}

// 4. Copy SSR bundle (dynamically imported at runtime)
const ssrDir = resolve(root, '.guren/ssr')
if (existsSync(ssrDir)) {
  cpSync(ssrDir, resolve(funcDir, '.guren/ssr'), { recursive: true })
}

// 5. Copy db/migrations dir (checked at boot for hasMigrations)
const migrationsDir = resolve(root, 'db/migrations')
if (existsSync(migrationsDir)) {
  cpSync(migrationsDir, resolve(funcDir, 'db/migrations'), { recursive: true })
}

// 6. Static assets (served via Vercel CDN)
const publicDir = resolve(root, 'public')
if (existsSync(publicDir)) {
  cpSync(publicDir, resolve(out, 'static'), { recursive: true })
}

console.log('Vercel Build Output assembled at .vercel/output/')
console.log('Inertia env:', JSON.stringify(env, null, 2))
