import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectCloudflareBackend } from './backend'
import { buildCloudflareOutput } from './build'
import { assertSizeReportable, reportBundleSize } from './bundle-size'
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
    expect(manifest.vars).toEqual({ NODE_ENV: 'production' })
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

  test('should keep the carried-over ids when the build fails after the reset', async () => {
    scaffoldApp(root, { cfBackend: true })
    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })
    const path = join(root, '.guren/cloudflare/guren-worker.json')
    writeJson(path, { ...readManifest(root), resolved: { DB: { id: 'e902bc31-46b4-47dc-9d46-194d0b86148c' } } })
    // Two migrations that flatten to one file name fail the build after the reset.
    mkdirSync(join(root, 'db/migrations/0001_init'), { recursive: true })
    writeFileSync(join(root, 'db/migrations/0001_init/migration.sql'), 'select 1;\n')
    writeFileSync(join(root, 'db/migrations/0001_init.sql'), 'select 1;\n')

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow()

    expect(readManifest(root).resolved).toEqual({ DB: { id: 'e902bc31-46b4-47dc-9d46-194d0b86148c' } })
  })

  test('should add one every-minute trigger when the schedule kernel registers tasks', async () => {
    scaffoldApp(root, { cfBackend: true })
    mkdirSync(join(root, 'app/Console'), { recursive: true })
    writeFileSync(
      join(root, 'app/Console/Kernel.ts'),
      'export function registerSchedules(scheduler: { schedule(define: (s: { call(fn: () => void): { hourly(): unknown } }) => void): void }) {\n  scheduler.schedule((s) => { s.call(() => {}).hourly() })\n}\n',
    )

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    expect(readManifest(root).crons).toEqual(['* * * * *'])
  })

  // handler.scheduled throws with no scheduler bound, so the sweep alone would fail every minute.
  test('should add no trigger without scheduled tasks, the OAuth sweep included', async () => {
    scaffoldApp(root, { cfBackend: true, mcpPlugin: true, oauthProvider: true })

    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }))

    expect(readManifest(root).crons).toEqual([])
    expect(readManifest(root).scheduleUnreadable).toBeUndefined()
  })

  test('should add no guessed trigger for a kernel it cannot read, and say so', async () => {
    scaffoldApp(root, { cfBackend: true })
    mkdirSync(join(root, 'app/Console'), { recursive: true })
    writeFileSync(join(root, 'app/Console/Kernel.ts'), 'throw new Error("kernel broke")\n')

    const warnings = await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    expect(readManifest(root).crons).toEqual([])
    expect(readManifest(root).scheduleUnreadable).toContain('kernel broke')
    expect(warnings).toContain('kernel broke')
  })

  test('should take mcpOAuth and resource names from config/cloudflare.ts', async () => {
    scaffoldApp(root, { cfBackend: true, mcpPlugin: true, oauthProvider: true })
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config/cloudflare.ts'), "export default { mcpOAuth: true, resourceNames: { DB: 'demo-db', OAUTH_KV: 'demo-oauth' } }\n")

    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    const manifest = readManifest(root)
    expect(manifest.kvNamespaces).toEqual(['OAUTH_KV'])
    expect(manifest.d1.databaseName).toBe('demo-db')
    expect(manifest.resourceNames).toEqual({ DB: 'demo-db', OAUTH_KV: 'demo-oauth' })
  })

  test('should refuse --mcp-oauth when config/cloudflare.ts says otherwise, and warn when it says nothing', async () => {
    scaffoldApp(root, { cfBackend: true, mcpPlugin: true, oauthProvider: true })
    const warnings = await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true }))
    expect(warnings).toContain('Set mcpOAuth in config/cloudflare.ts')

    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config/cloudflare.ts'), 'export default { mcpOAuth: false }\n')
    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: true })).rejects.toThrow(/contradicts mcpOAuth/)
  })

  test('should refuse a config/cloudflare.ts of the wrong shape', async () => {
    scaffoldApp(root, { cfBackend: true })
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config/cloudflare.ts'), "export default { mcpOAuth: 'yes', resourceNames: { DB: '' } }\n")

    const failure = await buildCloudflareOutput({ rootDir: root, skipAppBuild: true }).catch((error: Error) => error.message)

    expect(failure).toContain('mcpOAuth is not a boolean')
    expect(failure).toContain('resourceNames is not a record of non-empty names')
  })

  test('should mount the OAuth provider at the mcpPath config/cloudflare.js gives', async () => {
    scaffoldApp(root, { cfBackend: true, mcpPlugin: true, oauthProvider: true })
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config/cloudflare.js'), "export default { mcpOAuth: true, mcpPath: '/api/mcp' }\n")

    await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    expect(readFileSync(join(root, '.guren/cloudflare/worker.js'), 'utf8')).toContain('"/api/mcp"')
  })

  test('should refuse resourceNames that are not a record of names', async () => {
    scaffoldApp(root, { cfBackend: true })
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config/cloudflare.ts'), "export default { resourceNames: { DB: '' } }\n")

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(/resourceNames is not a record of non-empty names/)
  })

  test('should warn that the wrangler backend ignores config/cloudflare.ts', async () => {
    scaffoldApp(root)
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config/cloudflare.ts'), 'export default { mcpOAuth: true }\n')

    const warnings = await captureWarnings(() => buildCloudflareOutput({ rootDir: root, skipAppBuild: true }))

    expect(warnings).toContain('is read only on the cf backend')
  })

  test('should name the --report-size flag when cloudflare:build is asked for a size it cannot measure', () => {
    scaffoldApp(root, { cfBackend: true })

    expect(() => assertSizeReportable(root, 'Cloudflare build --report-size')).toThrow(/^Cloudflare build --report-size: .*Drop it/)
    expect(() => assertSizeReportable(join(root, '.'))).toThrow(root)
  })

  test('should refuse cloudflare:size, which measures through wrangler.jsonc', () => {
    scaffoldApp(root, { cfBackend: true })
    mkdirSync(join(root, '.guren'), { recursive: true })

    expect(() => reportBundleSize({ root })).toThrow(/deploys through cf/)
  })
})
