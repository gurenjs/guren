/**
 * Assemble Vercel Build Output API structure.
 *
 * Uses `bun build` to bundle the server entrypoint into a single file,
 * avoiding circular workspace symlink issues with file copying.
 */
import { cpSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
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

// 2. Function config
writeFileSync(
  resolve(funcDir, '.vc-config.json'),
  JSON.stringify(
    {
      handler: 'index.js',
      runtime: 'bun1.x',
      launcherType: 'Nodejs',
      shouldAddHelpers: true,
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

// 4. Copy docs content (read at runtime by DocsService)
const docsDir = resolve(root, 'app/Services')
if (existsSync(docsDir)) {
  // DocsService reads markdown files from disk — check if there's a content directory
  const contentDirs = ['docs', 'content', 'resources/docs']
  for (const dir of contentDirs) {
    const src = resolve(root, dir)
    if (existsSync(src)) {
      cpSync(src, resolve(funcDir, dir), { recursive: true })
    }
  }
}

// 5. Copy SSR bundle (dynamically imported at runtime)
const ssrDir = resolve(root, '.guren/ssr')
if (existsSync(ssrDir)) {
  cpSync(ssrDir, resolve(funcDir, '.guren/ssr'), { recursive: true })
}

// 6. Copy Vite manifests (read at runtime for asset URLs)
const manifestPaths = [
  'public/assets/.vite/manifest.json',
  'public/assets/.vite/ssr-manifest.json',
]
for (const rel of manifestPaths) {
  const src = resolve(root, rel)
  if (existsSync(src)) {
    const dest = resolve(funcDir, rel)
    mkdirSync(resolve(dest, '..'), { recursive: true })
    cpSync(src, dest)
  }
}

// 7. Copy db/migrations dir (checked at boot for hasMigrations)
const migrationsDir = resolve(root, 'db/migrations')
if (existsSync(migrationsDir)) {
  cpSync(migrationsDir, resolve(funcDir, 'db/migrations'), { recursive: true })
}

// 8. Static assets (served via Vercel CDN)
const publicDir = resolve(root, 'public')
if (existsSync(publicDir)) {
  cpSync(publicDir, resolve(out, 'static'), { recursive: true })
}

console.log('Vercel Build Output assembled at .vercel/output/')
