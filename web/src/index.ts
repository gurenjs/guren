/**
 * Vercel Serverless Function entrypoint.
 *
 * Skips autoConfigureInertiaAssets (which registers hono/bun serveStatic
 * that fails on Vercel's read-only filesystem). Instead, configure
 * Inertia environment variables manually from Vite manifests.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import app from './app.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')

// -- Inertia asset config (replaces autoConfigureInertiaAssets) --

process.env.NODE_ENV = 'production'

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

// Client manifest
const clientManifest = loadManifest(
  resolve(rootDir, 'public/assets/.vite/manifest.json'),
  resolve(rootDir, 'public/assets/manifest.json'),
)

if (clientManifest) {
  const entry = clientManifest['resources/js/app.tsx']
  if (entry?.file) {
    process.env.GUREN_INERTIA_ENTRY = `/public/assets/${entry.file}`
  }
  if (entry?.css?.length) {
    process.env.GUREN_INERTIA_STYLES = entry.css
      .map((f) => `/public/assets/${f}`)
      .join(',')
  }
}

// SSR manifest
const ssrManifest = loadManifest(
  resolve(rootDir, '.guren/ssr/.vite/manifest.json'),
  resolve(rootDir, '.guren/ssr/manifest.json'),
)

if (ssrManifest) {
  const ssrEntry = ssrManifest['resources/js/ssr.tsx']
  if (ssrEntry?.file) {
    process.env.GUREN_INERTIA_SSR_ENTRY = resolve(rootDir, '.guren/ssr', ssrEntry.file)
  }

  const ssrManifestPath = [
    resolve(rootDir, '.guren/ssr/.vite/manifest.json'),
    resolve(rootDir, '.guren/ssr/manifest.json'),
  ].find((p) => existsSync(p))

  if (ssrManifestPath) {
    process.env.GUREN_INERTIA_SSR_MANIFEST = ssrManifestPath
  }
}

// Import map
process.env.GUREN_INERTIA_IMPORT_MAP = JSON.stringify({
  '@guren/inertia-client': '/vendor/inertia-client.tsx',
})

// -- Boot app (without autoConfigureInertiaAssets) --

await app.boot()

export default {
  fetch: (request: Request) => app.fetch(request),
}
