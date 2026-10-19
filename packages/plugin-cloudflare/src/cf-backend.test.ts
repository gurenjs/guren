import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCloudflareOutput, detectCloudflareBackend } from './build'
import { reportBundleSize } from './bundle-size'
import type { WorkerManifest } from './worker-manifest'

import { captureWarnings, scaffoldApp, writeAgentModule, writeAgentsConfig, writeJson } from '../tests/app-fixture'

function readManifest(root: string): WorkerManifest {
  return JSON.parse(readFileSync(join(root, '.guren/cloudflare/guren-worker.json'), 'utf8')) as WorkerManifest
}

describe('cloudflare:build on the cf backend (RFC 0035)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-backend-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('should pick the backend from cloudflare.config.ts and the declared cf package', () => {
    scaffoldApp(root)
    expect(detectCloudflareBackend(root)).toBe('wrangler')

    scaffoldApp(root, { cfBackend: true })
    expect(detectCloudflareBackend(root)).toBe('cf')
  })

  test('should refuse cloudflare.config.ts when the app does not declare cf', async () => {
    scaffoldApp(root)
    writeFileSync(join(root, 'cloudflare.config.ts'), 'export default {}\n')

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(/bun add -d cf wrangler/)
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false)
  })

  test('should assemble into .guren/cloudflare and write the manifest instead of wrangler.jsonc', async () => {
    scaffoldApp(root, { cfBackend: true })

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    expect(existsSync(join(root, '.guren/cloudflare/worker.js'))).toBe(true)
    expect(existsSync(join(root, '.cloudflare'))).toBe(false)
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false)
    expect(readFileSync(join(root, '.guren/cloudflare/.gitignore'), 'utf8')).toBe('*\n')

    const manifest = readManifest(root)
    expect(manifest.entrypoint).toBe('./.guren/cloudflare/worker.js')
    expect(manifest.assetsDirectory).toBe('./.guren/cloudflare/assets')
    expect(manifest.alias['bun:sqlite']).toBe('./.guren/cloudflare/stub-bun-sqlite.js')
    expect(manifest.define['process.env.NODE_ENV']).toBe('"production"')
    expect(manifest.d1).toEqual({ binding: 'DB', databaseName: 'demo-app' })
    expect(manifest.kvNamespaces).toEqual([])
    expect(manifest.agents).toEqual([])
    expect(manifest.resolved).toEqual({})
  })

  test('should carry the previous build\'s resolved section over the output reset', async () => {
    scaffoldApp(root, { cfBackend: true })
    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })
    const path = join(root, '.guren/cloudflare/guren-worker.json')
    writeJson(path, { ...readManifest(root), resolved: { DB: { id: 'e902bc31-46b4-47dc-9d46-194d0b86148c', name: 'demo-app' } } })

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    expect(readManifest(root).resolved).toEqual({ DB: { id: 'e902bc31-46b4-47dc-9d46-194d0b86148c', name: 'demo-app' } })
  })

  test('should record OAUTH_KV in the manifest under --mcp-oauth, with no wrangler.jsonc to check', async () => {
    scaffoldApp(root, { cfBackend: true, mcpPlugin: true, oauthProvider: true })

    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }))

    expect(readManifest(root).kvNamespaces).toEqual(['OAUTH_KV'])
    expect(readManifest(root).mcpOAuth).toBe(true)
  })

  test('should list agents with their bindings, and not check a wrangler.jsonc cf never reads', async () => {
    scaffoldApp(root, { cfBackend: true, agentsPlugin: true })
    writeAgentsConfig(root, { triager: { module: 'app/Agents/Triager.ts', export: 'Triager' } })
    writeAgentModule(root, 'app/Agents/Triager.ts', 'Triager')
    // Left behind by `cf migrate`, binding nothing: the wrangler backend would refuse it.
    writeJson(join(root, 'wrangler.jsonc'), { name: 'demo-app', d1_databases: [{ binding: 'DB', database_id: 'TODO' }] })

    const warnings = await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    expect(readManifest(root).agents).toEqual([{ exportName: 'Triager', binding: 'TRIAGER' }])
    expect(warnings).not.toContain('placeholder')
    expect(readFileSync(join(root, '.guren/cloudflare/worker.js'), 'utf8')).toContain('export { Triager }')
  })

  test('should refuse cloudflare:size, which measures through wrangler.jsonc', () => {
    scaffoldApp(root, { cfBackend: true })
    mkdirSync(join(root, '.guren'), { recursive: true })

    expect(() => reportBundleSize({ root })).toThrow(/deploys through cf/)
  })
})
