import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { configureInertiaAssets, autoConfigureInertiaAssets } from '../../src/http/inertia-assets'

const ENV_KEYS = [
  'GUREN_INERTIA_ENTRY',
  'GUREN_INERTIA_STYLES',
  'GUREN_INERTIA_SSR_ENTRY',
  'GUREN_INERTIA_SSR_MANIFEST',
  'GUREN_INERTIA_IMPORT_MAP',
]

function clearEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
}

describe('inertia assets', () => {
  const originalEnv = { ...process.env }
  const bunRef = (
    globalThis as {
      Bun?: {
        file?: (...args: any[]) => any
        Transpiler?: new (...args: any[]) => any
      }
    }
  ).Bun
  const originalBunFile = bunRef?.file
  const originalBunTranspiler = bunRef?.Transpiler

  beforeEach(() => {
    process.env = { ...originalEnv }
    clearEnv()
  })

  it('sets dev inertia env flags', () => {
    if (bunRef) {
      bunRef.Transpiler = class {}
      bunRef.file = () => ({ exists: async () => false })
    }

    const app = {
      hono: { get: () => {}, use: () => {} },
      use: () => {},
    } as any

    process.env.NODE_ENV = 'development'

    configureInertiaAssets(app, {
      stylesEntry: '/assets/app.css',
      ssrEntry: '/app/ssr.tsx',
      importMeta: import.meta,
    })

    expect(process.env.GUREN_INERTIA_STYLES).toBe('/assets/app.css')
    expect(process.env.GUREN_INERTIA_SSR_ENTRY).toBe('/app/ssr.tsx')
    expect(process.env.GUREN_INERTIA_SSR_MANIFEST).toBe('')
  })

  it('sets production inertia env flags', () => {
    const app = { hono: { get: () => {} }, use: () => {} } as any
    process.env.NODE_ENV = 'production'

    configureInertiaAssets(app, {
      stylesEntry: '/public/assets/app.css',
      scriptEntry: '/public/assets/app.js',
      ssrEntry: '/build/ssr/entry.js',
      ssrManifest: '/build/ssr/manifest.json',
      publicPath: false,
      inertiaClient: false,
    })

    expect(process.env.GUREN_INERTIA_STYLES).toBe('/public/assets/app.css')
    expect(process.env.GUREN_INERTIA_ENTRY).toBe('/public/assets/app.js')
    expect(process.env.GUREN_INERTIA_SSR_ENTRY).toBe('/build/ssr/entry.js')
    expect(process.env.GUREN_INERTIA_SSR_MANIFEST).toBe('/build/ssr/manifest.json')
  })

  it('auto-configures dev entries and import maps', () => {
    if (bunRef) {
      bunRef.Transpiler = class {}
      bunRef.file = () => ({ exists: async () => false })
    }

    const app = {
      hono: { get: () => {}, use: () => {} },
      use: () => {},
    } as any

    process.env.NODE_ENV = 'development'

    autoConfigureInertiaAssets(app, {
      importMeta: import.meta,
      devServerUrl: 'http://localhost:5174',
      enableSsr: false,
    })

    expect(process.env.GUREN_INERTIA_ENTRY).toBe('http://localhost:5174/resources/js/dev-entry.ts')
    expect(process.env.GUREN_INERTIA_STYLES).toBe('/resources/css/app.css')
    expect(process.env.GUREN_INERTIA_SSR_ENTRY).toBe('')
    expect(process.env.GUREN_INERTIA_IMPORT_MAP).toContain('@guren/inertia-client')
  })

  afterEach(() => {
    if (bunRef) {
      bunRef.file = originalBunFile
      bunRef.Transpiler = originalBunTranspiler
    }
  })
})
