import { configureInertiaAssets } from '@guren/server'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import app from './app'
import '../routes/web'

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
  const isProduction = process.env.NODE_ENV === 'production'

  if (!isProduction) {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173'
    process.env.GUREN_INERTIA_ENTRY = process.env.GUREN_INERTIA_ENTRY ?? `${devServerUrl}/resources/js/dev-entry.ts`
    process.env.GUREN_INERTIA_STYLES = process.env.GUREN_INERTIA_STYLES ?? ''
    return
  }

  const manifest = loadViteManifest()
  const entry = manifest?.['resources/js/app.tsx']

  if (entry?.file && !process.env.GUREN_INERTIA_ENTRY) {
    process.env.GUREN_INERTIA_ENTRY = `/public/assets/${entry.file}`
  }

  if (entry?.css?.length && !process.env.GUREN_INERTIA_STYLES) {
    process.env.GUREN_INERTIA_STYLES = entry.css.map((href) => `/public/assets/${href}`).join(',')
  }
}

type ViteManifest = Record<string, { file: string; css?: string[] }>

function loadViteManifest(): ViteManifest | undefined {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url))
    const manifestPath = resolve(moduleDir, '../public/assets/manifest.json')
    const raw = readFileSync(manifestPath, 'utf8')
    return JSON.parse(raw) as ViteManifest
  } catch (error) {
    console.warn('Unable to load Vite manifest. Run `bunx vite build` before starting in production.', error)
    return undefined
  }
}
