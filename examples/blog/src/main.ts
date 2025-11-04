import { configureInertiaAssets } from '@guren/server'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import app from './app.js'
import '../routes/web.js'
import '../app/Models/relations.js'

configureViteAssets()
configureInertiaAssets(app, {
  importMeta: import.meta,
})

export async function bootstrap() {
  await app.boot()
  return app
}

export const ready = bootstrap()

export default app

function configureViteAssets() {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const isProduction = process.env.NODE_ENV === 'production'

  if (!isProduction) {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173'
    process.env.GUREN_INERTIA_ENTRY = process.env.GUREN_INERTIA_ENTRY ?? `${devServerUrl}/resources/js/dev-entry.ts`
    process.env.GUREN_INERTIA_STYLES = process.env.GUREN_INERTIA_STYLES ?? ''
    process.env.GUREN_INERTIA_SSR_ENTRY = process.env.GUREN_INERTIA_SSR_ENTRY ?? resolve(moduleDir, '../resources/js/ssr.tsx')
    process.env.GUREN_INERTIA_SSR_MANIFEST = process.env.GUREN_INERTIA_SSR_MANIFEST ?? ''
    return
  }

  const clientManifestPath = resolve(moduleDir, '../public/assets/manifest.json')
  const clientManifest = loadViteManifest(clientManifestPath, 'client')
  const clientEntry = clientManifest?.['resources/js/app.tsx']

  if (clientEntry?.file && !process.env.GUREN_INERTIA_ENTRY) {
    process.env.GUREN_INERTIA_ENTRY = `/public/assets/${clientEntry.file}`
  }

  if (clientEntry?.css?.length && !process.env.GUREN_INERTIA_STYLES) {
    process.env.GUREN_INERTIA_STYLES = clientEntry.css.map((href) => `/public/assets/${href}`).join(',')
  }

  const ssrManifestPath = resolve(moduleDir, '../bootstrap/ssr/manifest.json')
  const ssrManifest = loadViteManifest(ssrManifestPath, 'SSR')
  const ssrEntry = ssrManifest?.['resources/js/ssr.tsx']

  if (ssrEntry?.file && !process.env.GUREN_INERTIA_SSR_ENTRY) {
    process.env.GUREN_INERTIA_SSR_ENTRY = resolve(moduleDir, '../bootstrap/ssr', ssrEntry.file)
  }

  if (ssrManifest && !process.env.GUREN_INERTIA_SSR_MANIFEST) {
    process.env.GUREN_INERTIA_SSR_MANIFEST = ssrManifestPath
  }
}

type ViteManifestEntry = {
  file: string
  css?: string[]
  assets?: string[]
  imports?: string[]
  dynamicImports?: string[]
}

type ViteManifest = Record<string, ViteManifestEntry>

function loadViteManifest(manifestPath: string, label: 'client' | 'SSR'): ViteManifest | undefined {
  try {
    const raw = readFileSync(manifestPath, 'utf8')
    return JSON.parse(raw) as ViteManifest
  } catch (error) {
    const command = label === 'SSR' ? 'bunx vite build --ssr' : 'bunx vite build'
    console.warn(`Unable to load ${label} Vite manifest at ${manifestPath}. Run \`${command}\` before starting in production.`, error)
    return undefined
  }
}
