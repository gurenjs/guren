import { describe, test, expect } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CF_OUTPUT_DIR, WORKER_MANIFEST_FILE } from '../src/worker-manifest'
import { workerManifest } from './app-fixture'

/**
 * `cf` evaluates cloudflare.config.ts under Node, so `@guren/plugin-cloudflare/config`
 * must load there with nothing but builtins: no Bun API, no `@guren/*`, no build tooling.
 * A Bun-only import passes every other test here and fails only inside `cf`.
 */
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const built = existsSync(`${packageDir}/dist/config.js`)

function importsOf(file: string): string[] {
  const source = readFileSync(`${packageDir}/src/${file}`, 'utf8')
  return [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gmu)].map((match) => match[1] as string)
}

describe('cf config subpath', () => {
  test('should import only node builtins and the manifest module', () => {
    for (const specifier of importsOf('config.ts')) {
      expect(specifier.startsWith('node:') || specifier === './worker-manifest').toBe(true)
    }
    expect(importsOf('worker-manifest.ts')).toEqual([])
  })
})

describe.if(built)('cf config subpath (built, under Node)', () => {
  test('should read the manifest and return the worker in a plain Node process', () => {
    const app = mkdtempSync(join(tmpdir(), 'guren-cf-config-node-'))
    try {
      mkdirSync(join(app, CF_OUTPUT_DIR), { recursive: true })
      writeFileSync(
        join(app, CF_OUTPUT_DIR, WORKER_MANIFEST_FILE),
        JSON.stringify(workerManifest()),
      )
      const script = `import(${JSON.stringify(`${packageDir}/dist/config.js`)})`
        + ".then((m) => m.gurenWorker({ name: 'demo-app' }))"
        + '.then((worker) => process.stdout.write(JSON.stringify(worker.env)))'
      const result = Bun.spawnSync({ cmd: ['node', '--input-type=module', '-e', script], cwd: app, stdout: 'pipe', stderr: 'pipe' })

      expect(result.stderr.toString()).toBe('')
      expect(JSON.parse(result.stdout.toString())).toEqual({ DB: { type: 'd1', name: 'demo-app' }, NODE_ENV: { type: 'text', value: 'production' } })
    } finally {
      rmSync(app, { recursive: true, force: true })
    }
  })
})
