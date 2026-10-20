import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scaffoldApp, writeJson } from '../../tests/app-fixture'
import type { CfResult } from './cf-cli'
import { compareVersions, planCloudflareDeploy, type CloudflareDeployOptions } from './deploy'

const DB_ID = 'e902bc31-46b4-47dc-9d46-194d0b86148c'

/** Installs what preflight looks for: cf's bin and a Wrangler of `wranglerVersion`. */
function installTools(root: string, wranglerVersion = '4.151.1'): void {
  mkdirSync(join(root, 'node_modules/cf/bin'), { recursive: true })
  writeFileSync(join(root, 'node_modules/cf/bin/cf'), '')
  writeJson(join(root, 'node_modules/cf/package.json'), { name: 'cf', version: '1.0.0-beta.18' })
  mkdirSync(join(root, 'node_modules/wrangler'), { recursive: true })
  writeJson(join(root, 'node_modules/wrangler/package.json'), { name: 'wrangler', version: wranglerVersion })
}

/** A cf that is logged in, writes worker.config.json on `build`, and lists `d1` as given. */
function fakeCf(root: string, d1: unknown[], calls: string[][] = []) {
  return (args: string[]): CfResult => {
    calls.push(args)
    const ok = (value: unknown): CfResult => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })
    if (args[0] === 'auth') return ok({ authenticated: true })
    if (args[0] === 'build') {
      mkdirSync(join(root, '.cloudflare/output/v0/workers/default'), { recursive: true })
      writeJson(join(root, '.cloudflare/output/v0/workers/default/worker.config.json'), {
        name: 'demo-app',
        env: { DB: { type: 'd1', name: 'demo-app' }, NODE_ENV: { type: 'text', value: 'production' } },
      })
      return ok(null)
    }
    if (args[0] === 'd1') return ok(d1)
    if (args[0] === 'kv') return ok([])
    return { exitCode: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` }
  }
}

describe('cloudflare:deploy --plan', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-deploy-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function options(overrides: Partial<CloudflareDeployOptions> = {}): CloudflareDeployOptions {
    return {
      root,
      plan: true,
      skipAppBuild: true,
      cf: fakeCf(root, []),
      nodeVersion: () => 'v24.22.0',
      interactive: false,
      ...overrides,
    }
  }

  test('should refuse to run without --plan, before building anything', async () => {
    scaffoldApp(root, { cfBackend: true })
    installTools(root)

    await expect(planCloudflareDeploy(options({ plan: false }))).rejects.toThrow(/only `--plan`/)
    expect(existsSync(join(root, '.guren/cloudflare'))).toBe(false)
  })

  test('should refuse an app on the wrangler backend', async () => {
    scaffoldApp(root)

    await expect(planCloudflareDeploy(options())).rejects.toThrow(/needs the cf backend/)
  })

  test('should fail preflight on a Node cf cannot load the config with, before building', async () => {
    scaffoldApp(root, { cfBackend: true })
    installTools(root)

    await expect(planCloudflareDeploy(options({ nodeVersion: () => 'v22.14.0' }))).rejects.toThrow(/Node 22\.18\.0 or later; found v22\.14\.0/)
    expect(existsSync(join(root, '.guren/cloudflare'))).toBe(false)
  })

  test('should fail preflight on a Wrangler below the delegate floor, and on no node at all', async () => {
    scaffoldApp(root, { cfBackend: true })
    installTools(root, '4.129.0')

    const failure = await planCloudflareDeploy(options({ nodeVersion: () => undefined })).catch((error: Error) => error.message)

    expect(failure).toContain('found no node')
    expect(failure).toContain('4.136.0 or later; found 4.129.0')
  })

  test('should fail preflight when cf is not logged in, naming the login', async () => {
    scaffoldApp(root, { cfBackend: true })
    installTools(root)
    const cf = (args: string[]): CfResult =>
      args[0] === 'auth'
        ? { exitCode: 0, stdout: JSON.stringify({ authenticated: false, error: 'Not logged in' }), stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'not reached' }

    await expect(planCloudflareDeploy(options({ cf }))).rejects.toThrow(/Not logged in.*cf auth login/s)
  })

  test('should build, evaluate the config, and plan the database against the account', async () => {
    scaffoldApp(root, { cfBackend: true })
    installTools(root)
    const calls: string[][] = []

    const plan = await planCloudflareDeploy(options({ cf: fakeCf(root, [{ uuid: DB_ID, name: 'demo-app' }], calls) }))

    expect(plan.worker).toBe('demo-app')
    expect(plan.bindings).toEqual([{ binding: 'DB', type: 'd1', action: 'adopt', name: 'demo-app', id: DB_ID }])
    expect(plan.findings).toEqual([])
    expect(existsSync(join(root, '.guren/cloudflare/guren-worker.json'))).toBe(true)
    // No KV binding in the evaluated config, so no KV listing.
    expect(calls.map((call) => call[0])).toEqual(['auth', 'build', 'd1'])
  })

  test('should not read a worker.config.json an earlier build left when cf build writes none', async () => {
    scaffoldApp(root, { cfBackend: true })
    installTools(root)
    mkdirSync(join(root, '.cloudflare/output/v0/workers/default'), { recursive: true })
    writeJson(join(root, '.cloudflare/output/v0/workers/default/worker.config.json'), { name: 'stale', env: {} })
    const cf = (args: string[]): CfResult =>
      ({ exitCode: 0, stdout: args[0] === 'auth' ? '{"authenticated":true}' : '[]', stderr: '' })

    await expect(planCloudflareDeploy(options({ cf }))).rejects.toThrow(/worker\.config\.json is missing/)
  })

  test('should keep stdout for the JSON when asked, sending the build\'s lines to stderr', async () => {
    scaffoldApp(root, { cfBackend: true })
    installTools(root)
    const logged: unknown[] = []
    const log = console.log
    console.log = (...args: unknown[]) => logged.push(args)
    try {
      await planCloudflareDeploy(options({ logToStderr: true }))
    } finally {
      console.log = log
    }

    expect(logged).toEqual([])
  })

  test('should not plan a creation for a non-interactive run without --provision', async () => {
    scaffoldApp(root, { cfBackend: true })
    installTools(root)

    const plan = await planCloudflareDeploy(options({ ci: true }))

    expect(plan.findings.map((finding) => finding.check)).toEqual(['resource-missing'])
    expect((await planCloudflareDeploy(options({ ci: true, provision: true }))).findings).toEqual([])
  })

  test('should stop when cf build cannot evaluate the config', async () => {
    scaffoldApp(root, { cfBackend: true })
    installTools(root)
    const cf = (args: string[]): CfResult =>
      args[0] === 'auth'
        ? { exitCode: 0, stdout: '{"authenticated":true}', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'Invalid `cloudflare.config.ts`' }

    await expect(planCloudflareDeploy(options({ cf }))).rejects.toThrow(/cf build.*Invalid `cloudflare\.config\.ts`/s)
  })
})

describe('compareVersions', () => {
  test('should compare the numeric prefix against a floor', () => {
    expect(compareVersions('v22.18.0', [22, 18, 0])).toBe(0)
    expect(compareVersions('v22.14.0', [22, 18, 0])).toBeLessThan(0)
    expect(compareVersions('24.1.0', [22, 18, 0])).toBeGreaterThan(0)
    expect(compareVersions('nonsense', [22, 18, 0])).toBeLessThan(0)
  })
})
