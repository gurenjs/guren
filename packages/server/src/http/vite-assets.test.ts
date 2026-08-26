import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { viteAsset, __resetViteAssetCache } from './vite-assets'

describe('viteAsset', () => {
  let tempDir: string
  const savedNodeEnv = process.env.NODE_ENV
  const savedDevServerUrl = process.env.VITE_DEV_SERVER_URL
  const savedInjectedManifest = process.env.GUREN_VITE_MANIFEST

  // The filesystem cache alone would need no lifecycle reset (every test's
  // manifestPaths point into a fresh temp dir), but the injected-manifest
  // memo is keyed on nothing, so it must not leak across tests.
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'guren-vite-assets-'))
    delete process.env.GUREN_VITE_MANIFEST
    __resetViteAssetCache()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    process.env.NODE_ENV = savedNodeEnv
    if (savedDevServerUrl === undefined) {
      delete process.env.VITE_DEV_SERVER_URL
    } else {
      process.env.VITE_DEV_SERVER_URL = savedDevServerUrl
    }
    if (savedInjectedManifest === undefined) {
      delete process.env.GUREN_VITE_MANIFEST
    } else {
      process.env.GUREN_VITE_MANIFEST = savedInjectedManifest
    }
  })

  const productionEnv = () => {
    process.env.NODE_ENV = 'production'
    delete process.env.VITE_DEV_SERVER_URL
  }

  const writeManifest = (entries: Record<string, unknown>): string => {
    const path = join(tempDir, 'manifest.json')
    writeFileSync(path, JSON.stringify(entries))
    return path
  }

  describe('development', () => {
    test('should point at the dev server when VITE_DEV_SERVER_URL is set', () => {
      process.env.NODE_ENV = 'production'
      process.env.VITE_DEV_SERVER_URL = 'http://localhost:5199/'

      expect(viteAsset('resources/css/app.css')).toBe(
        'http://localhost:5199/resources/css/app.css',
      )
    })

    test('should default to localhost:5173 outside production', () => {
      process.env.NODE_ENV = 'development'
      delete process.env.VITE_DEV_SERVER_URL

      expect(viteAsset('/resources/css/app.css')).toBe(
        'http://localhost:5173/resources/css/app.css',
      )
    })
  })

  describe('production', () => {
    test('should resolve a manifest entry to its hashed public URL', () => {
      productionEnv()
      const manifestPath = writeManifest({
        'resources/css/app.css': { file: 'app-a1b2c3.css' },
      })

      expect(viteAsset('resources/css/app.css', { manifestPaths: [manifestPath] })).toBe(
        '/public/assets/app-a1b2c3.css',
      )
    })

    test('should throw naming the checked paths when no manifest exists', () => {
      productionEnv()
      const missing = join(tempDir, 'nope', 'manifest.json')

      expect(() => viteAsset('resources/css/app.css', { manifestPaths: [missing] })).toThrow(
        /no Vite manifest found[\s\S]*nope/,
      )
    })

    test('should throw naming the entry when the manifest does not record it', () => {
      productionEnv()
      const manifestPath = writeManifest({
        'resources/js/app.tsx': { file: 'app-ffffff.js' },
      })

      expect(() => viteAsset('resources/css/app.css', { manifestPaths: [manifestPath] })).toThrow(
        /"resources\/css\/app\.css" is not in the Vite manifest/,
      )
    })

    test('should resolve entries from an injected GUREN_VITE_MANIFEST without touching the filesystem', () => {
      productionEnv()
      process.env.GUREN_VITE_MANIFEST = JSON.stringify({
        'resources/css/app.css': { file: 'app-1nj3ct.css' },
      })

      // No manifest file exists anywhere in tempDir; only the env can answer.
      expect(viteAsset('resources/css/app.css')).toBe('/public/assets/app-1nj3ct.css')
    })

    test('should name the injected source when the entry is missing from it', () => {
      productionEnv()
      process.env.GUREN_VITE_MANIFEST = JSON.stringify({
        'resources/js/app.tsx': { file: 'app-ffffff.js' },
      })

      expect(() => viteAsset('resources/css/app.css')).toThrow(
        /not in the Vite manifest at GUREN_VITE_MANIFEST/,
      )
    })

    test('should let explicit manifestPaths read the named files over the injection', () => {
      // A caller stating paths is asking for exactly those files — tests and
      // unusual layouts must not be silently rerouted by ambient environment.
      productionEnv()
      process.env.GUREN_VITE_MANIFEST = JSON.stringify({
        'resources/css/app.css': { file: 'app-1nj3ct.css' },
      })
      const manifestPath = writeManifest({
        'resources/css/app.css': { file: 'app-f1l3.css' },
      })

      expect(viteAsset('resources/css/app.css', { manifestPaths: [manifestPath] })).toBe(
        '/public/assets/app-f1l3.css',
      )
    })

    test('should throw loudly on an injected value that is not manifest JSON', () => {
      // Falling through to the filesystem would end in "run bunx vite build",
      // pointing away from the variable that is actually broken.
      productionEnv()

      process.env.GUREN_VITE_MANIFEST = 'public/assets/manifest.json'
      expect(() => viteAsset('resources/css/app.css')).toThrow(/not valid JSON/)

      __resetViteAssetCache()
      process.env.GUREN_VITE_MANIFEST = '["not", "a", "manifest"]'
      expect(() => viteAsset('resources/css/app.css')).toThrow(/does not hold a manifest object/)
    })

    test('should memoize the injected manifest until the cache is reset', () => {
      productionEnv()
      process.env.GUREN_VITE_MANIFEST = JSON.stringify({
        'resources/css/app.css': { file: 'app-0ld000.css' },
      })
      expect(viteAsset('resources/css/app.css')).toBe('/public/assets/app-0ld000.css')

      process.env.GUREN_VITE_MANIFEST = JSON.stringify({
        'resources/css/app.css': { file: 'app-n3w000.css' },
      })
      expect(viteAsset('resources/css/app.css')).toBe('/public/assets/app-0ld000.css')

      __resetViteAssetCache()
      expect(viteAsset('resources/css/app.css')).toBe('/public/assets/app-n3w000.css')
    })

    test('should cache the manifest read per path set', () => {
      productionEnv()
      const manifestPath = writeManifest({
        'resources/css/app.css': { file: 'app-a1b2c3.css' },
      })
      expect(viteAsset('resources/css/app.css', { manifestPaths: [manifestPath] })).toBe(
        '/public/assets/app-a1b2c3.css',
      )

      // Rewrite on disk; the cached copy must keep answering until reset.
      writeFileSync(manifestPath, JSON.stringify({ 'resources/css/app.css': { file: 'app-zzz.css' } }))
      expect(viteAsset('resources/css/app.css', { manifestPaths: [manifestPath] })).toBe(
        '/public/assets/app-a1b2c3.css',
      )

      __resetViteAssetCache()
      expect(viteAsset('resources/css/app.css', { manifestPaths: [manifestPath] })).toBe(
        '/public/assets/app-zzz.css',
      )
    })
  })
})
