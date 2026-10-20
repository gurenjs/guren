import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectCloudflareBackend } from './backend'
import { buildCloudflareOutput } from './build'
import { initCloudflare } from './init'
import type { WorkerManifest } from './worker-manifest'

import { captureWarnings, scaffoldApp, writeJson } from '../tests/app-fixture'

describe('cloudflare:init', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-init-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('should write the three cf files for the Worker the build names', () => {
    scaffoldApp(root)
    writeJson(join(root, 'package.json'), { name: '@scope/demo-app' })

    const result = initCloudflare({ rootDir: root, compatibilityDate: '2026-10-20' })

    expect(result.written).toEqual(['cloudflare.config.ts', 'wrangler.config.ts', 'config/cloudflare.ts'])
    const config = readFileSync(join(root, 'cloudflare.config.ts'), 'utf8')
    expect(config).toContain("gurenWorker({ name: \"demo-app\" })")
    expect(config).toContain('compatibilityDate: "2026-10-20"')
    expect(readFileSync(join(root, 'wrangler.config.ts'), 'utf8')).toContain('defineWranglerConfig(gurenWranglerBundle())')
    expect(readFileSync(join(root, 'config/cloudflare.ts'), 'utf8')).toContain('mcpOAuth: false,')
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.cloudflare/\n')
  })

  // An existing database keeps its name, and an OAuth app stays one, so the first cf deploy binds what Wrangler did.
  test('should carry the D1 name and OAUTH_KV over from wrangler.jsonc', () => {
    scaffoldApp(root)
    writeFileSync(join(root, 'wrangler.jsonc'), `{
      // comments are allowed
      "name": "demo-app",
      "d1_databases": [{ "binding": "DB", "database_name": "legacy-db", "database_id": "e902bc31-46b4-47dc-9d46-194d0b86148c" }],
      "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "0123456789abcdef0123456789abcdef" }],
      "durable_objects": { "bindings": [] },
    }`)

    const result = initCloudflare({ rootDir: root })

    const deployConfig = readFileSync(join(root, 'config/cloudflare.ts'), 'utf8')
    expect(deployConfig).toContain('mcpOAuth: true,')
    expect(deployConfig).toContain('resourceNames: { DB: "legacy-db" },')
    expect(result.carried).toHaveLength(2)
    expect(result.warnings.join(' ')).toContain('Open Question 5')
  })

  test('should refuse to overwrite without --force', () => {
    scaffoldApp(root)
    writeFileSync(join(root, 'wrangler.config.ts'), 'export default {}\n')

    expect(() => initCloudflare({ rootDir: root })).toThrow(/wrangler\.config\.ts already exist/)
    expect(readFileSync(join(root, 'wrangler.config.ts'), 'utf8')).toBe('export default {}\n')
    expect(initCloudflare({ rootDir: root, force: true }).written).toContain('wrangler.config.ts')
  })

  test('should leave an existing .cloudflare/ ignore line alone', () => {
    scaffoldApp(root)
    writeFileSync(join(root, '.gitignore'), 'node_modules\n.cloudflare/\n')

    initCloudflare({ rootDir: root })

    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n.cloudflare/\n')
  })

  test('should put the app on the cf backend once cf is declared, with the build reading the new config', async () => {
    scaffoldApp(root, { cfBackend: true })
    rmSync(join(root, 'cloudflare.config.ts'))
    writeFileSync(join(root, 'wrangler.jsonc'), '{ "name": "demo-app", "d1_databases": [{ "binding": "DB", "database_name": "legacy-db" }] }')

    initCloudflare({ rootDir: root })
    // The written config imports @guren/plugin-cloudflare/config, which this temp app cannot resolve; the build only reads config/cloudflare.ts.
    writeFileSync(join(root, 'config/cloudflare.ts'), readFileSync(join(root, 'config/cloudflare.ts'), 'utf8')
      .replace("import { defineCloudflareConfig } from '@guren/plugin-cloudflare/config'\n", 'const defineCloudflareConfig = <T>(config: T) => config\n'))
    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    expect(detectCloudflareBackend(root)).toBe('cf')
    const manifest = JSON.parse(readFileSync(join(root, '.guren/cloudflare/guren-worker.json'), 'utf8')) as WorkerManifest
    expect(manifest.d1.databaseName).toBe('legacy-db')
  }, 30_000)
})
