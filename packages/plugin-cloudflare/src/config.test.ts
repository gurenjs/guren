import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindings, exports, type WorkerConfig } from '@cloudflare/config/public'

import { gurenWorker, gurenWranglerBundle } from './config'
import { WORKER_MANIFEST_VERSION, type WorkerManifest } from './worker-manifest'

function manifest(overrides: Partial<WorkerManifest> = {}): WorkerManifest {
  return {
    version: WORKER_MANIFEST_VERSION,
    entrypoint: './.guren/cloudflare/worker.js',
    assetsDirectory: './.guren/cloudflare/assets',
    compatibilityFlags: ['nodejs_compat'],
    htmlHandling: 'none',
    alias: { 'bun:sqlite': './.guren/cloudflare/stub-bun-sqlite.js' },
    define: { 'process.env.NODE_ENV': '"production"' },
    d1: { binding: 'DB', databaseName: 'demo-app' },
    kvNamespaces: [],
    mcpOAuth: false,
    agents: [],
    resolved: {},
    ...overrides,
  }
}

describe('@guren/plugin-cloudflare/config', () => {
  let outputDir: string

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), 'guren-cf-config-'))
  })

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true })
  })

  function write(value: unknown): void {
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(join(outputDir, 'guren-worker.json'), JSON.stringify(value))
  }

  // The objects must be what cf/config's own helpers build, or `cf` rejects or misreads them.
  test('should emit the bindings and exports cf/config builds, id-less until resolved', async () => {
    write(manifest({
      kvNamespaces: ['OAUTH_KV'],
      agents: [{ exportName: 'Triager', binding: 'TRIAGER' }],
    }))

    const worker = await gurenWorker({ name: 'demo-app', outputDir })

    expect(worker.env).toEqual({
      DB: bindings.d1({ name: 'demo-app' }),
      OAUTH_KV: bindings.kv({}),
      TRIAGER: bindings.durableObject({ worker: 'demo-app', exportName: 'Triager' }),
    })
    expect(worker.exports as Record<string, unknown>).toEqual({ Triager: exports.durableObject({ storage: 'sqlite' }) })
    expect(worker.entrypoint).toBe('./.guren/cloudflare/worker.js')
    expect(worker.assets).toEqual({ htmlHandling: 'none' })
  })

  test('should pin each binding to the resource the manifest resolved', async () => {
    write(manifest({
      kvNamespaces: ['OAUTH_KV'],
      resolved: {
        DB: { id: 'e902bc31-46b4-47dc-9d46-194d0b86148c', name: 'shared-db' },
        OAUTH_KV: { id: '0123456789abcdef0123456789abcdef' },
      },
    }))

    const worker = await gurenWorker({ name: 'demo-app', outputDir })

    expect(worker.env.DB).toEqual(bindings.d1({ name: 'shared-db', id: 'e902bc31-46b4-47dc-9d46-194d0b86148c' }))
    expect(worker.env.OAUTH_KV).toEqual(bindings.kv({ id: '0123456789abcdef0123456789abcdef' }))
  })

  test('should be assignable to cf\'s WorkerConfig once the config file adds its date', async () => {
    write(manifest())

    const config: WorkerConfig = { ...(await gurenWorker({ name: 'demo-app', outputDir })), compatibilityDate: '2026-10-01' }

    expect(config.name).toBe('demo-app')
  })

  test('should pin keepNames in the bundler options', async () => {
    write(manifest())

    expect(await gurenWranglerBundle({ outputDir })).toEqual({
      keepNames: true,
      alias: { 'bun:sqlite': './.guren/cloudflare/stub-bun-sqlite.js' },
      define: { 'process.env.NODE_ENV': '"production"' },
      assetsDirectory: './.guren/cloudflare/assets',
    })
  })

  test('should name cloudflare:build when the manifest is missing', async () => {
    await expect(gurenWorker({ name: 'demo-app', outputDir: join(outputDir, 'none') })).rejects.toThrow(
      /bunx guren cloudflare:build/,
    )
  })

  test('should refuse a manifest of another version', async () => {
    write({ ...manifest(), version: 99 })

    await expect(gurenWranglerBundle({ outputDir })).rejects.toThrow(/manifest version 99/)
  })
})
