import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installCfTools, scaffoldApp, writeJson, writeMigration } from '../../tests/app-fixture'
import type { CliResult } from './cf-cli'
import { planCloudflareDeploy, type CloudflareDeployOptions } from './deploy'

const DB_ID = 'e902bc31-46b4-47dc-9d46-194d0b86148c'

/** A cf that is logged in, writes worker.config.json on `build`, lists `d1` as given, and answers the tracker and secrets. */
function fakeCf(root: string, d1: unknown[], calls: string[][] = [], extra: { tracker?: string[]; secrets?: string[] } = {}) {
  return (args: string[]): CliResult => {
    calls.push(args)
    const ok = (value: unknown): CliResult => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })
    if (args[0] === 'auth') return ok({ authenticated: true })
    if (args[0] === 'build') {
      mkdirSync(join(root, '.cloudflare/output/v0/workers/default'), { recursive: true })
      writeJson(join(root, '.cloudflare/output/v0/workers/default/worker.config.json'), {
        name: 'demo-app',
        env: { DB: { type: 'd1', name: 'demo-app' }, NODE_ENV: { type: 'text', value: 'production' } },
      })
      return ok(null)
    }
    if (args[0] === 'd1' && args[1] === 'query') return ok([{ results: (extra.tracker ?? []).map((name) => ({ name })) }])
    if (args[0] === 'd1') return ok(d1)
    if (args[0] === 'kv') return ok([])
    if (args[0] === 'workers') {
      return extra.secrets
        ? ok(extra.secrets.map((name) => ({ name, type: 'secret_text' })))
        : { exitCode: 1, stdout: '', stderr: 'workers.api.error.script_not_found' }
    }
    return { exitCode: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` }
  }
}

/** An env schema of the shape `loadEnvSchema()` reads, requiring APP_KEY in production. */
const ENV_SCHEMA = `export default {
  vars: { APP_KEY: { defaultValue: undefined, isSecret: true } },
  parse: () => ({ values: {}, unset: new Set(['APP_KEY']) }),
}
`

describe('cloudflare:deploy --plan', () => {
  let root: string
  // A run inside GitHub Actions reads the workflow file for the serialization check;
  // the release workflow has no concurrency group, so the runner's env would add a finding.
  const githubActions = process.env.GITHUB_ACTIONS

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-deploy-'))
    delete process.env.GITHUB_ACTIONS
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    if (githubActions === undefined) delete process.env.GITHUB_ACTIONS
    else process.env.GITHUB_ACTIONS = githubActions
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

  test('should fail preflight on a Node cf cannot load the config with, before building', async () => {
    scaffoldApp(root, { cfBackend: true })
    installCfTools(root)

    await expect(planCloudflareDeploy(options({ nodeVersion: () => 'v22.14.0' }))).rejects.toThrow(/Node 22\.18\.0 or later; found v22\.14\.0/)
    expect(existsSync(join(root, '.guren/cloudflare'))).toBe(false)
  })

  test('should fail preflight on a Wrangler below the delegate floor, and on no node at all', async () => {
    scaffoldApp(root, { cfBackend: true })
    installCfTools(root, '4.129.0')

    const failure = await planCloudflareDeploy(options({ nodeVersion: () => undefined })).catch((error: Error) => error.message)

    expect(failure).toContain('found no node')
    expect(failure).toContain('4.136.0 or later; found 4.129.0')
  })

  test('should fail preflight on a Wrangler without the cf build entry, which a Vite app is built through', async () => {
    scaffoldApp(root, { cfBackend: true })
    installCfTools(root)
    rmSync(join(root, 'node_modules/wrangler/bin/cf-wrangler.js'))

    await expect(planCloudflareDeploy(options())).rejects.toThrow(/has no bin\/cf-wrangler\.js/)
    expect(existsSync(join(root, '.guren/cloudflare'))).toBe(false)
  })

  test('should fail preflight when cf is not logged in, naming the login', async () => {
    scaffoldApp(root, { cfBackend: true })
    installCfTools(root)
    const cf = (args: string[]): CliResult =>
      args[0] === 'auth'
        ? { exitCode: 0, stdout: JSON.stringify({ authenticated: false, error: 'Not logged in' }), stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'not reached' }

    await expect(planCloudflareDeploy(options({ cf }))).rejects.toThrow(/Not logged in.*cf auth login/s)
  })

  test('should build, evaluate the config, and plan the database against the account', async () => {
    scaffoldApp(root, { cfBackend: true })
    installCfTools(root)
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
    installCfTools(root)
    mkdirSync(join(root, '.cloudflare/output/v0/workers/default'), { recursive: true })
    writeJson(join(root, '.cloudflare/output/v0/workers/default/worker.config.json'), { name: 'stale', env: {} })
    const cf = (args: string[]): CliResult =>
      ({ exitCode: 0, stdout: args[0] === 'auth' ? '{"authenticated":true}' : '[]', stderr: '' })

    await expect(planCloudflareDeploy(options({ cf }))).rejects.toThrow(/worker\.config\.json is missing/)
  })

  test('should keep stdout for the JSON when asked, sending the build\'s lines to stderr', async () => {
    scaffoldApp(root, { cfBackend: true })
    installCfTools(root)
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
    installCfTools(root)

    const plan = await planCloudflareDeploy(options({ ci: true }))

    expect(plan.findings.map((finding) => finding.check)).toEqual(['resource-missing'])
    expect((await planCloudflareDeploy(options({ ci: true, provision: true }))).findings).toEqual([])
  })

  test('should stop when cf build cannot evaluate the config', async () => {
    scaffoldApp(root, { cfBackend: true })
    installCfTools(root)
    const cf = (args: string[]): CliResult =>
      args[0] === 'auth'
        ? { exitCode: 0, stdout: '{"authenticated":true}', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'Invalid `cloudflare.config.ts`' }

    await expect(planCloudflareDeploy(options({ cf }))).rejects.toThrow(/cf build.*Invalid `cloudflare\.config\.ts`/s)
  })

  test('should judge the migrations the database has not applied, on the layout its tracker records', async () => {
    scaffoldApp(root, { cfBackend: true })
    installCfTools(root)
    writeMigration(root, '20261001_init', 'CREATE TABLE posts (id integer primary key);\n')
    writeMigration(root, '20261002_drop', 'DROP TABLE posts;\n')
    const calls: string[][] = []

    const plan = await planCloudflareDeploy(options({ cf: fakeCf(root, [{ uuid: DB_ID, name: 'demo-app' }], calls, { tracker: ['20261001_init.sql'] }) }))

    expect(calls).toContainEqual(['d1', 'query', DB_ID, '--sql', 'select name from d1_migrations order by id'])
    expect(plan.migrations).toMatchObject({ layout: 'flat', pending: ['20261002_drop'] })
    expect(plan.findings.map((finding) => [finding.check, finding.severity])).toEqual([['destructive-migration', 'blocker']])
    expect(plan.findings[0]?.message).toContain('db/migrations/20261002_drop/migration.sql:1')

    const allowed = await planCloudflareDeploy(options({ cf: fakeCf(root, [{ uuid: DB_ID, name: 'demo-app' }], [], { tracker: ['20261001_init.sql'] }), allowDestructive: true }))
    expect(allowed.findings.map((finding) => finding.severity)).toEqual(['warning'])
  })

  // A table the same run creates loses nothing when it is dropped.
  test('should judge a database to be created against every local migration', async () => {
    scaffoldApp(root, { cfBackend: true })
    installCfTools(root)
    writeMigration(root, '20261001_init', 'CREATE TABLE posts (id integer primary key);\n')
    writeMigration(root, '20261002_drop', 'DROP TABLE posts;\n')
    const calls: string[][] = []

    const plan = await planCloudflareDeploy(options({ cf: fakeCf(root, [], calls), provision: true }))

    expect(calls.some((call) => call[1] === 'query')).toBe(false)
    expect(plan.migrations).toMatchObject({ layout: 'flat', pending: ['20261001_init', '20261002_drop'] })
    expect(plan.findings).toEqual([])
  })

  test('should read required variables from config/env.ts and accept them from the deployed worker or a secrets file', async () => {
    scaffoldApp(root, { cfBackend: true })
    installCfTools(root)
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config/env.ts'), ENV_SCHEMA)

    const firstDeploy = await planCloudflareDeploy(options({ cf: fakeCf(root, [{ uuid: DB_ID, name: 'demo-app' }], [], {}) }))
    expect(firstDeploy.missingSecrets).toEqual(['APP_KEY'])
    expect(firstDeploy.findings[0]?.check).toBe('secrets')

    // Copied from .env.example, the key is still blank: unset to the schema.
    writeFileSync(join(root, '.env.production'), 'APP_KEY=\n')
    const blank = await planCloudflareDeploy(options({ cf: fakeCf(root, [{ uuid: DB_ID, name: 'demo-app' }], [], {}), secretsFile: join(root, '.env.production') }))
    expect(blank.missingSecrets).toEqual(['APP_KEY'])

    writeFileSync(join(root, '.env.production'), 'APP_KEY=base64:never-read\n')
    const withFile = await planCloudflareDeploy(options({ cf: fakeCf(root, [{ uuid: DB_ID, name: 'demo-app' }], [], {}), secretsFile: join(root, '.env.production') }))
    expect(withFile.missingSecrets).toEqual([])

    const deployed = await planCloudflareDeploy(options({ cf: fakeCf(root, [{ uuid: DB_ID, name: 'demo-app' }], [], { secrets: ['APP_KEY'] }) }))
    expect(deployed.findings).toEqual([])
  })
})
