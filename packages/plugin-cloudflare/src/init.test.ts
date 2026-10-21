import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectCloudflareBackend } from './backend'
import { buildCloudflareOutput } from './build'
import { initCloudflare } from './init'
import type { WorkerManifest } from './worker-manifest'

import { captureWarnings, scaffoldApp, writeAgentModule, writeAgentsConfig, writeJson } from '../tests/app-fixture'

describe('cloudflare:init', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-init-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('should write the three cf files for the Worker the build names', async () => {
    scaffoldApp(root)
    writeJson(join(root, 'package.json'), { name: '@scope/demo-app' })

    const result = await initCloudflare({ rootDir: root, compatibilityDate: '2026-10-20' })

    expect(result.written).toEqual(['cloudflare.config.ts', 'wrangler.config.ts', 'config/cloudflare.ts'])
    const config = readFileSync(join(root, 'cloudflare.config.ts'), 'utf8')
    expect(config).toContain("gurenWorker({ name: \"demo-app\" })")
    expect(config).toContain('compatibilityDate: "2026-10-20"')
    expect(readFileSync(join(root, 'wrangler.config.ts'), 'utf8')).toContain('defineWranglerConfig(gurenWranglerBundle())')
    expect(readFileSync(join(root, 'config/cloudflare.ts'), 'utf8')).toContain('mcpOAuth: false,')
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.cloudflare/\n')
  })

  // An existing database keeps its name, and an OAuth app stays one, so the first cf deploy binds what Wrangler did.
  test('should carry the Worker, date, D1 name and OAUTH_KV namespace over from wrangler.jsonc', async () => {
    scaffoldApp(root)
    writeFileSync(join(root, 'wrangler.jsonc'), `{
      // comments are allowed
      "name": "prod-api",
      "compatibility_date": "2025-01-15",
      "d1_databases": [
        { "binding": "ANALYTICS", "database_name": "analytics" },
        { "binding": "DB", "database_name": "legacy-db", "database_id": "e902bc31-46b4-47dc-9d46-194d0b86148c" },
      ],
      "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "0123456789abcdef0123456789abcdef" }],
    }`)

    const result = await initCloudflare({ rootDir: root })

    const config = readFileSync(join(root, 'cloudflare.config.ts'), 'utf8')
    expect(config).toContain('gurenWorker({ name: "prod-api" })')
    expect(config).toContain('compatibilityDate: "2025-01-15"')
    expect(config).toContain('OAUTH_KV: bindings.kv({ id: "0123456789abcdef0123456789abcdef" })')
    const deployConfig = readFileSync(join(root, 'config/cloudflare.ts'), 'utf8')
    expect(deployConfig).toContain('mcpOAuth: true,')
    expect(deployConfig).toContain('resourceNames: { DB: "legacy-db" },')
    expect(result.carried).toHaveLength(3)
    // The ANALYTICS database is not the build's DB, so it is named as left behind.
    expect(result.warnings.join(' ')).toContain('the ANALYTICS binding')
  })

  test('should name what cf would no longer read, and warn about Durable Objects only when there are some', async () => {
    scaffoldApp(root)
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'demo-app',
      routes: [{ pattern: 'api.example.com/*' }],
      r2_buckets: [{ binding: 'MEDIA' }],
      vars: { NODE_ENV: 'production', FEATURE_X: '1' },
      compatibility_flags: ['nodejs_compat', 'streams_enable_constructors'],
      durable_objects: { bindings: [] },
      env: { production: { migrations: [{ tag: 'v1', new_sqlite_classes: ['Triager'] }] } },
    })

    const result = await initCloudflare({ rootDir: root })

    const [leftBehind, durable] = result.warnings
    expect(leftBehind).toContain('routes, r2_buckets, env')
    expect(leftBehind).toContain('compatibility_flags streams_enable_constructors')
    expect(leftBehind).toContain('vars.FEATURE_X')
    expect(durable).toContain('Open Question 5')
  })

  test('should not carry a placeholder OAUTH_KV id', async () => {
    scaffoldApp(root)
    writeJson(join(root, 'wrangler.jsonc'), { name: 'demo-app', kv_namespaces: [{ binding: 'OAUTH_KV', id: 'TODO: wrangler kv namespace create OAUTH_KV' }] })

    await initCloudflare({ rootDir: root })

    expect(readFileSync(join(root, 'cloudflare.config.ts'), 'utf8')).not.toContain('OAUTH_KV')
    expect(readFileSync(join(root, 'config/cloudflare.ts'), 'utf8')).toContain('mcpOAuth: true,')
  })

  test('should leave an existing file as it is without --force', async () => {
    scaffoldApp(root)
    writeFileSync(join(root, 'wrangler.config.ts'), 'export default {}\n')

    const result = await initCloudflare({ rootDir: root })

    expect(result).toMatchObject({ written: ['cloudflare.config.ts', 'config/cloudflare.ts'], skipped: ['wrangler.config.ts'] })
    expect(readFileSync(join(root, 'wrangler.config.ts'), 'utf8')).toBe('export default {}\n')
    expect((await initCloudflare({ rootDir: root, force: true })).written).toContain('wrangler.config.ts')
  })

  test('should leave an existing .cloudflare/ ignore line alone, CRLF included', async () => {
    scaffoldApp(root)
    writeFileSync(join(root, '.gitignore'), 'node_modules\r\n.cloudflare/\r\n')

    await initCloudflare({ rootDir: root })

    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\r\n.cloudflare/\r\n')
  })

  test('should put the app on the cf backend once cf is declared, with the build reading the new config', async () => {
    scaffoldApp(root, { cfBackend: true })
    rmSync(join(root, 'cloudflare.config.ts'))
    writeFileSync(join(root, 'wrangler.jsonc'), '{ "name": "demo-app", "d1_databases": [{ "binding": "DB", "database_name": "legacy-db" }] }')

    await initCloudflare({ rootDir: root })
    // The written config imports @guren/plugin-cloudflare/config, which this temp app cannot resolve; the build only reads config/cloudflare.ts.
    writeFileSync(join(root, 'config/cloudflare.ts'), readFileSync(join(root, 'config/cloudflare.ts'), 'utf8')
      .replace("import { defineCloudflareConfig } from '@guren/plugin-cloudflare/config'\n", 'const defineCloudflareConfig = <T>(config: T) => config\n'))
    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    expect(detectCloudflareBackend(root)).toBe('cf')
    const manifest = JSON.parse(readFileSync(join(root, '.guren/cloudflare/guren-worker.json'), 'utf8')) as WorkerManifest
    expect(manifest.d1.databaseName).toBe('legacy-db')
  }, 30_000)

  test('should carry a Durable Object outside the agent registry into cloudflare.config.ts as a cf export', async () => {
    scaffoldApp(root)
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'demo-app',
      durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }, { name: 'LEGACY', class_name: 'Legacy' }, { name: 'REMOTE', class_name: 'Remote', script_name: 'other' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }, { tag: 'v2', new_classes: ['Legacy'] }, { tag: 'v3', renamed_classes: [{ from: 'Old', to: 'Counter' }] }],
    })

    const result = await initCloudflare({ rootDir: root, compatibilityDate: '2026-10-01' })

    const config = readFileSync(join(root, 'cloudflare.config.ts'), 'utf8')
    expect(config).toContain("import { bindings, defineConfig, exports } from 'cf/config'")
    expect(config).toContain('COUNTER: bindings.durableObject({ worker: "demo-app", exportName: "Counter" })')
    expect(config).toContain('Counter: exports.durableObject({ storage: "sqlite" })')
    expect(config).toContain('Legacy: exports.durableObject({ storage: "legacy-kv" })')
    expect(config).not.toContain('Remote')
    expect(result.carried).toContainEqual('the Durable Object COUNTER (Counter, sqlite storage) as a cf export')
    expect(result.warnings.join('\n')).toContain('rename, delete or transfer')
    expect(result.warnings.join('\n')).toContain('REMOTE')
  })

  test('should leave the agent registry\'s Durable Objects to gurenWorker()', async () => {
    scaffoldApp(root, { agentsPlugin: true })
    writeAgentModule(root, 'app/Agents/SupportTriager.ts', 'SupportTriager')
    writeAgentsConfig(root, { triage: { module: 'app/Agents/SupportTriager.ts', export: 'SupportTriager' } })
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'demo-app',
      durable_objects: { bindings: [{ name: 'SUPPORT_TRIAGER', class_name: 'SupportTriager' }, { name: 'COUNTER', class_name: 'Counter' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['SupportTriager', 'Counter'] }],
    })

    await initCloudflare({ rootDir: root, compatibilityDate: '2026-10-01' })

    // Counter is named the way an agent's binding is, and is still carried: the registry decides.
    const config = readFileSync(join(root, 'cloudflare.config.ts'), 'utf8')
    expect(config).not.toContain('SupportTriager')
    expect(config).toContain('Counter: exports.durableObject({ storage: "sqlite" })')
  })

  test('should raise cf and wrangler to what the cf backend needs, and leave a satisfying range alone', async () => {
    scaffoldApp(root)
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
    writeJson(join(root, 'package.json'), { ...manifest, devDependencies: { wrangler: '^4.129.0' } })

    expect((await initCloudflare({ rootDir: root })).dependencies).toEqual(['cf@1.0.0-beta.18', 'wrangler@^4.136.0'])
    expect((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies: unknown }).devDependencies).toEqual({
      wrangler: '^4.136.0',
      cf: '1.0.0-beta.18',
    })

    expect((await initCloudflare({ rootDir: root, force: true })).dependencies).toEqual([])
  })
})
