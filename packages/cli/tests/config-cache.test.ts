import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

await mock.module('consola', () => ({
  consola: {
    info: mock(() => {}),
    success: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    log: mock(() => {}),
  },
}))

const {
  cacheConfig,
  clearConfigCache,
  loadCachedConfig,
  hasConfigCache,
  showConfigCacheInfo,
} = await import('../src/config-cache')

describe('config-cache', () => {
  let tempDir: string
  let originalCwd: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'guren-cli-config-test-'))
    originalCwd = process.cwd()
    process.chdir(tempDir)

    // Create config directory
    await mkdir(join(tempDir, 'config'), { recursive: true })
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('cacheConfig', () => {
    it('creates cache directory if it does not exist', async () => {
      await writeFile(
        join(tempDir, 'config/app.ts'),
        `export default { name: 'test-app' }`
      )

      const cacheFile = await cacheConfig({ appRoot: tempDir })

      expect(cacheFile).toContain('bootstrap/cache/config.json')

      const exists = await access(cacheFile)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(true)
    })

    it('caches configuration from config files', async () => {
      await writeFile(
        join(tempDir, 'config/app.ts'),
        `export default { name: 'my-app', debug: true }`
      )
      await writeFile(
        join(tempDir, 'config/database.ts'),
        `export default { driver: 'sqlite', path: './db.sqlite' }`
      )

      await cacheConfig({ appRoot: tempDir })

      const config = loadCachedConfig({ appRoot: tempDir })
      expect(config).not.toBeNull()
      expect(config?.app).toEqual({ name: 'my-app', debug: true })
      expect(config?.database).toEqual({ driver: 'sqlite', path: './db.sqlite' })
    })

    it('throws error when config directory does not exist', async () => {
      await rm(join(tempDir, 'config'), { recursive: true, force: true })

      await expect(cacheConfig({ appRoot: tempDir })).rejects.toThrow('Config directory not found')
    })

    it('uses custom config directory when specified', async () => {
      await mkdir(join(tempDir, 'custom-config'), { recursive: true })
      await writeFile(
        join(tempDir, 'custom-config/settings.ts'),
        `export default { theme: 'dark' }`
      )

      await cacheConfig({
        appRoot: tempDir,
        configDir: 'custom-config',
      })

      const config = loadCachedConfig({ appRoot: tempDir })
      expect(config?.settings).toEqual({ theme: 'dark' })
    })

    it('uses custom cache directory when specified', async () => {
      await writeFile(
        join(tempDir, 'config/app.ts'),
        `export default { name: 'test' }`
      )

      const cacheFile = await cacheConfig({
        appRoot: tempDir,
        cacheDir: 'storage/cache',
      })

      expect(cacheFile).toContain('storage/cache/config.json')
    })

    it('skips test and spec files', async () => {
      await writeFile(
        join(tempDir, 'config/app.ts'),
        `export default { name: 'app' }`
      )
      await writeFile(
        join(tempDir, 'config/app.test.ts'),
        `export default { name: 'test' }`
      )
      await writeFile(
        join(tempDir, 'config/app.spec.ts'),
        `export default { name: 'spec' }`
      )

      await cacheConfig({ appRoot: tempDir })

      const config = loadCachedConfig({ appRoot: tempDir })
      expect(config).toHaveProperty('app')
      expect(config).not.toHaveProperty('app.test')
      expect(config).not.toHaveProperty('app.spec')
    })

    it('handles nested config directories', async () => {
      await mkdir(join(tempDir, 'config/services'), { recursive: true })
      await writeFile(
        join(tempDir, 'config/services/mail.ts'),
        `export default { driver: 'smtp' }`
      )

      await cacheConfig({ appRoot: tempDir })

      const config = loadCachedConfig({ appRoot: tempDir })
      expect(config?.mail).toEqual({ driver: 'smtp' })
    })

    it('supports named config export', async () => {
      await writeFile(
        join(tempDir, 'config/named.ts'),
        `export const config = { type: 'named' }`
      )

      await cacheConfig({ appRoot: tempDir })

      const config = loadCachedConfig({ appRoot: tempDir })
      expect(config?.named).toEqual({ type: 'named' })
    })
  })

  describe('clearConfigCache', () => {
    it('removes the cache file', async () => {
      await writeFile(
        join(tempDir, 'config/app.ts'),
        `export default { name: 'test' }`
      )
      await cacheConfig({ appRoot: tempDir })

      expect(hasConfigCache({ appRoot: tempDir })).toBe(true)

      const cleared = clearConfigCache({ appRoot: tempDir })

      expect(cleared).toBe(true)
      expect(hasConfigCache({ appRoot: tempDir })).toBe(false)
    })

    it('returns false when no cache exists', () => {
      const cleared = clearConfigCache({ appRoot: tempDir })

      expect(cleared).toBe(false)
    })
  })

  describe('loadCachedConfig', () => {
    it('returns null when no cache exists', () => {
      const config = loadCachedConfig({ appRoot: tempDir })

      expect(config).toBeNull()
    })

    it('returns cached config object', async () => {
      await writeFile(
        join(tempDir, 'config/app.ts'),
        `export default { name: 'cached-app' }`
      )
      await cacheConfig({ appRoot: tempDir })

      const config = loadCachedConfig({ appRoot: tempDir })

      expect(config).not.toBeNull()
      expect(config?.app).toEqual({ name: 'cached-app' })
    })

    it('returns null for invalid JSON', async () => {
      await mkdir(join(tempDir, 'bootstrap/cache'), { recursive: true })
      await writeFile(
        join(tempDir, 'bootstrap/cache/config.json'),
        'not valid json'
      )

      const config = loadCachedConfig({ appRoot: tempDir })

      expect(config).toBeNull()
    })
  })

  describe('hasConfigCache', () => {
    it('returns false when no cache exists', () => {
      expect(hasConfigCache({ appRoot: tempDir })).toBe(false)
    })

    it('returns true when cache exists', async () => {
      await writeFile(
        join(tempDir, 'config/app.ts'),
        `export default { name: 'test' }`
      )
      await cacheConfig({ appRoot: tempDir })

      expect(hasConfigCache({ appRoot: tempDir })).toBe(true)
    })
  })

  describe('showConfigCacheInfo', () => {
    it('does not throw when no cache exists', () => {
      expect(() => showConfigCacheInfo({ appRoot: tempDir })).not.toThrow()
    })

    it('does not throw when cache exists', async () => {
      await writeFile(
        join(tempDir, 'config/app.ts'),
        `export default { name: 'test' }`
      )
      await cacheConfig({ appRoot: tempDir })

      expect(() => showConfigCacheInfo({ appRoot: tempDir })).not.toThrow()
    })
  })

  describe('ConfigCacheOptions', () => {
    it('accepts all valid options', () => {
      const options = {
        configDir: 'custom-config',
        appRoot: '/app',
        cacheDir: 'storage/cache',
      }

      expect(options.configDir).toBe('custom-config')
      expect(options.appRoot).toBe('/app')
      expect(options.cacheDir).toBe('storage/cache')
    })
  })
})
