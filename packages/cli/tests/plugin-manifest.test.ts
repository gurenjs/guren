import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace, writeInstalledPackage, type TempWorkspace } from './helpers'
import {
  applyEnvEntries,
  applyPublishes,
  checkPluginCompatibility,
  readCoreVersion,
  readPluginManifest,
} from '../src/plugin-manifest'

const PLUGIN_NAME = '@acme/guren-plugin-audit'

describe('plugin-manifest', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-plugin-manifest-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  describe('readPluginManifest', () => {
    it('should return the gurenPlugin field of an installed package', async () => {
      await writeInstalledPackage(PLUGIN_NAME, {
        gurenPlugin: { compatibility: '>=1.0.0', provider: 'AuditProvider' },
      })

      const manifest = await readPluginManifest(PLUGIN_NAME)

      expect(manifest?.compatibility).toBe('>=1.0.0')
      expect(manifest?.provider).toBe('AuditProvider')
    })

    it('should return null when the package is not installed', async () => {
      expect(await readPluginManifest('@acme/missing')).toBeNull()
    })

    it('should return null when the package declares no gurenPlugin field', async () => {
      await writeInstalledPackage(PLUGIN_NAME, {})

      expect(await readPluginManifest(PLUGIN_NAME)).toBeNull()
    })
  })

  describe('readCoreVersion', () => {
    it('should return the installed core version', async () => {
      await writeInstalledPackage('@guren/core', { version: '1.2.0' })

      expect(await readCoreVersion()).toBe('1.2.0')
    })

    it('should return null when core is not installed', async () => {
      expect(await readCoreVersion()).toBeNull()
    })
  })

  describe('checkPluginCompatibility', () => {
    it('should pass when the core version satisfies the range', () => {
      const result = checkPluginCompatibility({ compatibility: '>=1.0.0' }, '1.2.0')

      expect(result).toEqual({ compatible: true, coreVersion: '1.2.0', range: '>=1.0.0' })
    })

    it('should fail when the core version is outside the range', () => {
      const result = checkPluginCompatibility({ compatibility: '>=2.0.0' }, '1.2.0')

      expect(result?.compatible).toBe(false)
    })

    it('should return null when no range is declared', () => {
      expect(checkPluginCompatibility({}, '1.2.0')).toBeNull()
    })

    it('should return null when the core version is unknown', () => {
      expect(checkPluginCompatibility({ compatibility: '>=1.0.0' }, null)).toBeNull()
    })
  })

  describe('applyEnvEntries', () => {
    it('should create .env.example and append missing keys', async () => {
      const modified = await applyEnvEntries([
        { key: 'AUDIT_API_KEY', comment: 'Audit service API key' },
        { key: 'AUDIT_ENDPOINT', value: 'https://audit.example.com' },
      ])

      expect(modified).toEqual(['.env.example'])
      const content = await readFile('.env.example', 'utf8')
      expect(content).toContain('# Audit service API key\nAUDIT_API_KEY=\n')
      expect(content).toContain('AUDIT_ENDPOINT=https://audit.example.com\n')
    })

    it('should append to an existing .env but not create one', async () => {
      await writeFile('.env', 'EXISTING=1\n')

      const modified = await applyEnvEntries([{ key: 'AUDIT_API_KEY' }])

      expect(modified).toEqual(['.env.example', '.env'])
      expect(await readFile('.env', 'utf8')).toBe('EXISTING=1\nAUDIT_API_KEY=\n')
    })

    it('should be idempotent for keys that already exist', async () => {
      await writeFile('.env.example', 'AUDIT_API_KEY=set\n')

      const modified = await applyEnvEntries([{ key: 'AUDIT_API_KEY' }])

      expect(modified).toEqual([])
      expect(await readFile('.env.example', 'utf8')).toBe('AUDIT_API_KEY=set\n')
    })

    it('should ignore entries with invalid keys', async () => {
      const modified = await applyEnvEntries([{ key: 'not-a-key' }, { key: 'lower' }])

      expect(modified).toEqual([])
    })
  })

  describe('applyPublishes', () => {
    beforeEach(async () => {
      await writeInstalledPackage(PLUGIN_NAME, {}, {
        'stubs/audit.ts': 'export const audit = true\n',
      })
    })

    it('should copy declared files into allowed directories', async () => {
      const result = await applyPublishes(PLUGIN_NAME, [
        { from: 'stubs/audit.ts', to: 'config/audit.ts' },
      ])

      expect(result.written).toEqual(['config/audit.ts'])
      expect(await readFile('config/audit.ts', 'utf8')).toBe('export const audit = true\n')
    })

    it('should skip existing files unless force is set', async () => {
      await mkdir('config', { recursive: true })
      await writeFile('config/audit.ts', 'export const custom = true\n')

      const result = await applyPublishes(PLUGIN_NAME, [
        { from: 'stubs/audit.ts', to: 'config/audit.ts' },
      ])

      expect(result.skipped).toEqual(['config/audit.ts'])
      expect(await readFile('config/audit.ts', 'utf8')).toBe('export const custom = true\n')

      const forced = await applyPublishes(PLUGIN_NAME, [
        { from: 'stubs/audit.ts', to: 'config/audit.ts' },
      ], { force: true })

      expect(forced.written).toEqual(['config/audit.ts'])
      expect(await readFile('config/audit.ts', 'utf8')).toBe('export const audit = true\n')
    })

    it('should reject targets outside the allowed directories', async () => {
      await expect(applyPublishes(PLUGIN_NAME, [
        { from: 'stubs/audit.ts', to: 'src/audit.ts' },
      ])).rejects.toThrow('must be inside')
    })

    it('should reject path traversal in targets', async () => {
      await expect(applyPublishes(PLUGIN_NAME, [
        { from: 'stubs/audit.ts', to: 'config/../../evil.ts' },
      ])).rejects.toThrow('escapes the project directory')
    })

    it('should reject sources escaping the package directory', async () => {
      await expect(applyPublishes(PLUGIN_NAME, [
        { from: '../../../etc/passwd', to: 'config/passwd.ts' },
      ])).rejects.toThrow('escapes the package directory')
    })

    it('should reject absolute paths', async () => {
      await expect(applyPublishes(PLUGIN_NAME, [
        { from: '/etc/passwd', to: 'config/passwd.ts' },
      ])).rejects.toThrow('absolute paths are not allowed')
    })

    it('should reject a source that is a symlink escaping the package directory', async () => {
      const secretPath = join(workspace.dir, 'secret.ts')
      await writeFile(secretPath, 'export const secret = true\n')
      await symlink(secretPath, join(workspace.dir, 'node_modules', PLUGIN_NAME, 'stubs', 'escape-link.ts'))

      await expect(applyPublishes(PLUGIN_NAME, [
        { from: 'stubs/escape-link.ts', to: 'config/audit.ts' },
      ])).rejects.toThrow('escapes the package directory')
    })

    it('should reject a target directory that is a symlink escaping the project directory', async () => {
      const outsideDir = join(workspace.dir, '..', `guren-cli-plugin-manifest-outside-${Date.now()}`)
      await mkdir(outsideDir, { recursive: true })
      await symlink(outsideDir, join(workspace.dir, 'config'))

      await expect(applyPublishes(PLUGIN_NAME, [
        { from: 'stubs/audit.ts', to: 'config/audit.ts' },
      ])).rejects.toThrow('escapes the project directory')
    })
  })
})
