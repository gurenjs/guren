import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installWranglerTools, scaffoldApp, writeJson, writeMigration } from '../../tests/app-fixture'
import type { CliResult } from './cf-cli'
import { runCloudflareDeploy, type CloudflareDeployOptions } from './deploy'
import { formatResult } from './report'
import { createWranglerResource, deployWithWrangler, readWranglerTracker } from './wrangler-cli'
import { evaluateWranglerConfig, renderWranglerDeployConfig, wranglerMigrationsBinding } from './wrangler-config'

const NEW_DB = 'aaaaaaaa-0000-4000-8000-000000000001'
const EXISTING_DB = 'e902bc31-46b4-47dc-9d46-194d0b86148c'
const KV_ID = '0123456789abcdef0123456789abcdef'

const ok = (value: unknown): CliResult => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })

describe('Wrangler CLI argv', () => {
  test('should never let a create write wrangler.jsonc, and read the id back by name', () => {
    const calls: string[][] = []
    const created = createWranglerResource((args) => {
      calls.push(args)
      return args[1] === 'create' ? { exitCode: 0, stdout: 'Created your new D1 database.', stderr: '' } : ok([{ uuid: NEW_DB, name: 'demo-app' }])
    }, 'd1', 'demo-app')

    expect(created).toEqual({ ok: true, value: NEW_DB })
    expect(calls).toEqual([['d1', 'create', 'demo-app', '--update-config=false'], ['d1', 'list', '--json']])
  })

  test('should read the remote tracker through the deploy config, and a missing table as nothing applied', () => {
    const calls: string[][] = []
    const missing = readWranglerTracker((args) => {
      calls.push(args)
      return { exitCode: 1, stdout: '{"error":{"text":"no such table: d1_migrations: SQLITE_ERROR"}}', stderr: '' }
    }, 'DB', ['-c', '.cloudflare/wrangler.deploy.json'])

    expect(missing).toEqual({ ok: true, value: null })
    expect(calls[0]).toEqual(['d1', 'execute', 'DB', '--remote', '--json', '--command', 'select name from d1_migrations order by id', '-c', '.cloudflare/wrangler.deploy.json'])
  })

  test('should deploy with provisioning off', () => {
    const calls: string[][] = []
    deployWithWrangler((args) => {
      calls.push(args)
      return ok(null)
    }, ['-c', '.cloudflare/wrangler.deploy.json'], '/abs/.env.production')

    expect(calls[0]).toEqual(['deploy', '-c', '.cloudflare/wrangler.deploy.json', '--x-provision=false', '--secrets-file', '/abs/.env.production'])
  })
})

describe('wrangler.jsonc as the plan reads it', () => {
  test('should read a placeholder id as none, and vars as values', () => {
    const worker = evaluateWranglerConfig({
      name: 'demo-app',
      d1_databases: [{ binding: 'DB', database_name: 'demo-db', database_id: 'TODO: wrangler d1 create' }],
      kv_namespaces: [{ binding: 'OAUTH_KV', id: KV_ID }],
      vars: { NODE_ENV: 'production', FLAGS: { beta: true } },
      triggers: { crons: ['* * * * *'] },
    })

    expect(worker).toEqual({
      name: 'demo-app',
      env: {
        DB: { type: 'd1', name: 'demo-db' },
        OAUTH_KV: { type: 'kv', id: KV_ID },
        NODE_ENV: { type: 'text' },
        FLAGS: { type: 'json' },
      },
      scheduled: true,
    })
  })

  test('should pick the D1 binding whose migrations_dir is the flattened copy, and refuse to guess between several', () => {
    const flat = '/app/.cloudflare/d1-migrations'
    const two = [
      { binding: 'DB', database_name: 'a', migrations_dir: '.cloudflare/d1-migrations' },
      { binding: 'ANALYTICS', database_name: 'b' },
    ]

    expect(wranglerMigrationsBinding({ d1_databases: two }, '/app', flat)).toEqual({ ok: true, value: 'DB' })
    expect(wranglerMigrationsBinding({ d1_databases: [{ binding: 'DB' }] }, '/app', flat)).toEqual({ ok: true, value: 'DB' })
    expect(wranglerMigrationsBinding({ d1_databases: [{ binding: 'DB', migrations_dir: 'migrations' }] }, '/app', flat).ok).toBe(false)
    expect(wranglerMigrationsBinding({ d1_databases: [two[1], { binding: 'OTHER' }] }, '/app', flat).ok).toBe(false)
    expect(wranglerMigrationsBinding({}, '/app', flat)).toEqual({ ok: true, value: undefined })
  })

  test('should render every path absolute and fill the resolved ids on the top level only', () => {
    const config = {
      name: 'demo-app',
      main: '.cloudflare/worker.js',
      tsconfig: 'tsconfig.json',
      alias: { 'bun:sqlite': './.cloudflare/stubs/bun-sqlite.js', react: 'preact/compat' },
      assets: { directory: '.cloudflare/assets', html_handling: 'none' },
      build: { command: 'bun run build' },
      d1_databases: [{ binding: 'DB', database_name: 'demo-app', migrations_dir: '.cloudflare/d1-migrations' }],
      kv_namespaces: [{ binding: 'OAUTH_KV' }],
      env: { staging: { main: '.cloudflare/worker.js', d1_databases: [{ binding: 'DB', database_name: 'demo-staging' }] } },
    }

    const rendered = renderWranglerDeployConfig({
      root: '/app',
      config,
      resolved: { DB: { id: EXISTING_DB, name: 'demo-app' }, OAUTH_KV: { id: KV_ID } },
      migrationsBinding: 'DB',
      flatDir: '/app/.cloudflare/d1-migrations',
    })

    expect(rendered).toMatchObject({
      main: '/app/.cloudflare/worker.js',
      tsconfig: '/app/tsconfig.json',
      alias: { 'bun:sqlite': '/app/.cloudflare/stubs/bun-sqlite.js', react: 'preact/compat' },
      assets: { directory: '/app/.cloudflare/assets', html_handling: 'none' },
      build: { command: 'bun run build', cwd: '/app' },
      d1_databases: [{ binding: 'DB', database_name: 'demo-app', database_id: EXISTING_DB, migrations_dir: '/app/.cloudflare/d1-migrations' }],
      kv_namespaces: [{ binding: 'OAUTH_KV', id: KV_ID }],
      env: { staging: { main: '/app/.cloudflare/worker.js', d1_databases: [{ binding: 'DB', database_name: 'demo-staging' }] } },
    })
    // The developer's config is read, never changed.
    expect(config.d1_databases[0]).not.toHaveProperty('database_id')
  })
})

interface FakeAccount {
  d1: Array<{ uuid: string; name: string }>
  kv?: Array<{ id: string; title: string }>
  tracker: string[] | null
  loggedIn?: boolean
  fail?: Partial<Record<'create' | 'deploy', string>>
}

/** A logged-in Wrangler over one account; every call is recorded. */
function fakeWrangler(account: FakeAccount, calls: string[][]) {
  return (args: string[]): CliResult => {
    calls.push(args)
    const [command, sub] = args
    if (command === 'whoami') return account.loggedIn === false ? { exitCode: 1, stdout: '', stderr: 'Not logged in.' } : ok({ loggedIn: true })
    if (command === 'd1' && sub === 'list') return ok(account.d1)
    if (command === 'kv' && args[2] === 'list') return ok(account.kv ?? [])
    if (command === 'd1' && sub === 'create') {
      if (account.fail?.create) return { exitCode: 1, stdout: '', stderr: account.fail.create }
      account.d1.push({ uuid: NEW_DB, name: args[2] as string })
      return { exitCode: 0, stdout: 'Created your new D1 database.', stderr: '' }
    }
    if (command === 'd1' && sub === 'execute') {
      if (account.tracker === null) return { exitCode: 1, stdout: '', stderr: 'no such table: d1_migrations' }
      return ok([{ results: account.tracker.map((name) => ({ name })), success: true }])
    }
    if (command === 'd1' && sub === 'time-travel') return ok({ bookmark: '0000-bookmark', timestamp: '2026-10-21T00:00:00Z' })
    if (command === 'd1' && sub === 'migrations') return { exitCode: 0, stdout: 'applied', stderr: '' }
    if (command === 'secret') return { exitCode: 1, stdout: '', stderr: 'This Worker does not exist on your account.' }
    if (command === 'deploy') {
      if (account.fail?.deploy) return { exitCode: 1, stdout: '', stderr: account.fail.deploy }
      return { exitCode: 0, stdout: 'Uploaded demo-app\n  https://demo-app.example.workers.dev\n', stderr: '' }
    }
    return { exitCode: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` }
  }
}

function writes(calls: string[][]): string[] {
  return calls
    .map((call) => call.slice(0, call[0] === 'deploy' ? 1 : 2).join(' '))
    .filter((name) => ['d1 create', 'kv namespace', 'd1 time-travel', 'd1 migrations', 'deploy'].includes(name))
}

describe('cloudflare:deploy on the Wrangler backend', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-wrangler-run-'))
    scaffoldApp(root)
    installWranglerTools(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function run(account: FakeAccount, calls: string[][], overrides: Partial<CloudflareDeployOptions> = {}) {
    return runCloudflareDeploy({
      root,
      skipAppBuild: true,
      wrangler: fakeWrangler(account, calls),
      nodeVersion: () => 'v24.22.0',
      interactive: false,
      yes: true,
      ...overrides,
    })
  }

  const deployConfig = () => JSON.parse(readFileSync(join(root, '.cloudflare/wrangler.deploy.json'), 'utf8')) as {
    d1_databases: Array<Record<string, unknown>>
  }

  test('should create, migrate and deploy through the rendered config, leaving wrangler.jsonc alone', async () => {
    writeMigration(root, '20261001_init', 'CREATE TABLE posts (id integer primary key);\n')
    const calls: string[][] = []

    const result = await run({ d1: [], tracker: null }, calls)

    expect(result.failure).toBeUndefined()
    expect(result.plan.backend).toBe('wrangler')
    expect(result.created).toEqual([{ binding: 'DB', type: 'd1', name: 'demo-app', id: NEW_DB }])
    expect(writes(calls)).toEqual(['d1 create', 'd1 time-travel', 'd1 migrations', 'deploy'])
    expect(calls).toContainEqual(['d1', 'migrations', 'apply', 'DB', '--remote', '-c', '.cloudflare/wrangler.deploy.json'])
    expect(calls).toContainEqual(['deploy', '-c', '.cloudflare/wrangler.deploy.json', '--x-provision=false'])
    expect(result.url).toBe('https://demo-app.example.workers.dev')

    expect(deployConfig().d1_databases[0]).toMatchObject({
      binding: 'DB',
      database_id: NEW_DB,
      migrations_dir: join(root, '.cloudflare/d1-migrations'),
    })
    const developer = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
    expect(developer).not.toContain(NEW_DB)
    expect(readFileSync(join(root, '.cloudflare/.gitignore'), 'utf8')).toContain('wrangler.deploy.json')
    expect(formatResult(result)).toContain('bunx wrangler rollback --name demo-app')
  })

  test('should keep what it settled, so the next run creates nothing and adopts nothing', async () => {
    const account: FakeAccount = { d1: [{ uuid: EXISTING_DB, name: 'demo-app' }], tracker: [] }
    await run(account, [])
    const calls: string[][] = []

    const again = await run(account, calls)

    expect(again.plan.bindings).toEqual([{ binding: 'DB', type: 'd1', action: 'existing', name: 'demo-app', id: EXISTING_DB }])
    expect(writes(calls)).toEqual(['deploy'])
    expect(deployConfig().d1_databases[0]?.database_id).toBe(EXISTING_DB)
  })

  test('should resolve D1 by the database_name wrangler.jsonc gives it', async () => {
    writeJson(join(root, 'wrangler.jsonc'), {
      name: 'demo-app',
      main: '.cloudflare/worker.js',
      d1_databases: [{ binding: 'DB', database_name: 'legacy-db', migrations_dir: '.cloudflare/d1-migrations' }],
    })
    const calls: string[][] = []

    const result = await run({ d1: [{ uuid: EXISTING_DB, name: 'legacy-db' }], tracker: [] }, calls, { plan: true })

    expect(result.plan.bindings[0]).toMatchObject({ action: 'adopt', name: 'legacy-db', id: EXISTING_DB })
    expect(writes(calls)).toEqual([])
  })

  test('should block a database whose tracker holds drizzle\'s nested names', async () => {
    writeMigration(root, '20261001_init', 'CREATE TABLE posts (id integer primary key);\n')

    const result = await run({ d1: [{ uuid: EXISTING_DB, name: 'demo-app' }], tracker: ['20261001_init/migration.sql'] }, [], { plan: true })

    expect(result.plan.findings).toContainEqual(expect.objectContaining({ check: 'tracker-layout', severity: 'blocker' }))
  })

  test('should list wrangler commands to undo a run that failed after creating', async () => {
    const calls: string[][] = []

    const result = await run({ d1: [], tracker: null, fail: { deploy: 'upload failed' } }, calls)

    expect(result.failure).toEqual({
      stage: 'deploy',
      message: 'wrangler deploy failed: upload failed',
      cleanup: ['bunx wrangler d1 delete demo-app'],
    })
  })

  test('should stop at preflight when Wrangler is too old or nobody is logged in, before building', async () => {
    installWranglerTools(root, '4.128.0')
    await expect(run({ d1: [], tracker: null }, [], { plan: true })).rejects.toThrow(/4\.129\.0 or later; found 4\.128\.0/)

    installWranglerTools(root)
    await expect(run({ d1: [], tracker: null, loggedIn: false }, [], { plan: true })).rejects.toThrow(/bunx wrangler login/)
    expect(existsSync(join(root, '.cloudflare'))).toBe(false)
  })
})

// Downloads wrangler; gated like wrangler-bundle.test.ts. Local only: no account is touched.
const realWrangler = process.env.GUREN_TEST_WRANGLER === '1'

describe.skipIf(!realWrangler)('the rendered config under Wrangler 4.129', () => {
  test('should bundle with provisioning off, and apply and read back the flattened migrations', () => {
    const root = mkdtempSync(join(tmpdir(), 'guren-wrangler-real-'))
    try {
      mkdirSync(join(root, '.cloudflare/assets'), { recursive: true })
      mkdirSync(join(root, '.cloudflare/stubs'), { recursive: true })
      mkdirSync(join(root, '.cloudflare/d1-migrations'), { recursive: true })
      writeFileSync(join(root, '.cloudflare/worker.js'), "import stub from 'bun:sqlite'\nexport default { fetch: () => new Response(String(stub)) }\n")
      writeFileSync(join(root, '.cloudflare/stubs/bun-sqlite.js'), 'export default "stubbed"\n')
      writeFileSync(join(root, '.cloudflare/assets/robots.txt'), 'User-agent: *\n')
      writeFileSync(join(root, '.cloudflare/d1-migrations/20261001_init.sql'), 'CREATE TABLE posts (id integer primary key);\n')
      const config = {
        name: 'demo-app',
        main: '.cloudflare/worker.js',
        compatibility_date: '2026-10-01',
        alias: { 'bun:sqlite': './.cloudflare/stubs/bun-sqlite.js' },
        assets: { directory: '.cloudflare/assets', html_handling: 'none' },
        d1_databases: [{ binding: 'DB', database_name: 'demo-app', migrations_dir: '.cloudflare/d1-migrations' }],
      }
      writeJson(join(root, 'wrangler.jsonc'), config)
      writeJson(join(root, '.cloudflare/wrangler.deploy.json'), renderWranglerDeployConfig({
        root,
        config,
        resolved: { DB: { id: EXISTING_DB } },
        migrationsBinding: 'DB',
        flatDir: join(root, '.cloudflare/d1-migrations'),
      }))
      const wrangler = (args: string[]): CliResult => {
        const result = Bun.spawnSync({
          cmd: ['bunx', 'wrangler@4.129.0', ...args],
          cwd: root,
          env: { ...process.env, CI: '1' },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        })
        return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
      }
      const configArgs = ['-c', '.cloudflare/wrangler.deploy.json']

      const dryRun = wrangler(['deploy', ...configArgs, '--x-provision=false', '--dry-run'])
      expect(dryRun.exitCode).toBe(0)
      expect(dryRun.stdout).toContain('env.DB (demo-app)')

      // The local database stands in for the remote one, whose output has the same shape.
      const local = (args: string[]) => wrangler(args.map((arg) => (arg === '--remote' ? '--local' : arg)))
      expect(readWranglerTracker(local, 'DB', configArgs)).toEqual({ ok: true, value: null })
      expect(local(['d1', 'migrations', 'apply', 'DB', '--remote', ...configArgs]).exitCode).toBe(0)
      expect(readWranglerTracker(local, 'DB', configArgs)).toEqual({ ok: true, value: ['20261001_init.sql'] })
      expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).not.toContain(EXISTING_DB)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 300_000)
})
