import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installCfTools, scaffoldApp, writeJson, writeMigration } from '../../tests/app-fixture'
import type { CliResult } from './cf-cli'
import { WORKER_MANIFEST_VERSION } from '../worker-manifest'
import { runCloudflareDeploy, type CloudflareDeployOptions } from './deploy'

const NEW_DB = 'aaaaaaaa-0000-4000-8000-000000000001'
const EXISTING_DB = 'e902bc31-46b4-47dc-9d46-194d0b86148c'

interface FakeAccount {
  d1: Array<{ uuid: string; name: string }>
  tracker: string[] | null
  /** Rows the tracker gains between the plan and the re-list, as another run would add. */
  trackerAfterPlan?: string[]
  fail?: Partial<Record<'create' | 'bookmark' | 'apply' | 'deploy', string>>
  /** An id cloudflare.config.ts sets after the gurenWorker() spread. */
  overrideDbId?: string
  /** An id cloudflare.config.ts sets for DB from the start, which the manifest never records. */
  configuredDbId?: string
}

/**
 * A logged-in cf over one account. `build` evaluates the manifest the way
 * gurenWorker() does, so a settled id reaches worker.config.json; writes are recorded.
 */
function fakeCf(root: string, account: FakeAccount, calls: string[][]) {
  let trackerReads = 0
  return (args: string[]): CliResult => {
    calls.push(args)
    const ok = (value: unknown): CliResult => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })
    const failed = (key: keyof NonNullable<FakeAccount['fail']>): CliResult | undefined =>
      account.fail?.[key] ? { exitCode: 1, stdout: '', stderr: account.fail[key] } : undefined
    const [command, sub] = args

    if (command === 'auth') return ok({ authenticated: true })
    if (command === 'build') {
      const manifest = JSON.parse(readFileSync(join(root, '.guren/cloudflare/guren-worker.json'), 'utf8')) as {
        resolved: Record<string, { id?: string; name?: string }>
      }
      const db = account.configuredDbId ? { id: account.configuredDbId } : manifest.resolved.DB
      mkdirSync(join(root, '.cloudflare/output/v0/workers/default'), { recursive: true })
      writeJson(join(root, '.cloudflare/output/v0/workers/default/worker.config.json'), {
        name: 'demo-app',
        env: {
          // The override is written after the spread, so it wins once gurenWorker() emits an id.
          DB: { type: 'd1', name: db?.name ?? 'demo-app', ...(db?.id ? { id: account.overrideDbId ?? db.id } : {}) },
        },
      })
      return ok(null)
    }
    if (command === 'd1' && sub === 'list') return ok(account.d1)
    if (command === 'd1' && sub === 'create') {
      const failure = failed('create')
      if (failure) return failure
      account.d1.push({ uuid: NEW_DB, name: args[3] as string })
      return ok({ uuid: NEW_DB, name: args[3] })
    }
    if (command === 'd1' && sub === 'query') {
      trackerReads++
      const rows = trackerReads > 1 && account.trackerAfterPlan ? account.trackerAfterPlan : account.tracker
      if (rows === null) return { exitCode: 1, stdout: '', stderr: 'no such table: d1_migrations' }
      return ok([{ results: rows.map((name) => ({ name })) }])
    }
    if (command === 'd1' && sub === 'time-travel') return failed('bookmark') ?? ok({ bookmark: '0000-bookmark' })
    if (command === 'd1' && sub === 'migrations') return failed('apply') ?? { exitCode: 0, stdout: 'applied', stderr: '' }
    if (command === 'kv') return ok([])
    if (command === 'deploy') {
      return failed('deploy') ?? { exitCode: 0, stdout: 'Deployed demo-app\n  https://demo-app.example.workers.dev\n', stderr: '' }
    }
    return { exitCode: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` }
  }
}

/** The write-side commands, in the order they ran. */
function writes(calls: string[][]): string[] {
  return calls
    .map((call) => call.slice(0, call[0] === 'deploy' || call[0] === 'build' ? 1 : 2).join(' '))
    .filter((name) => ['d1 create', 'kv namespaces', 'build', 'd1 time-travel', 'd1 migrations', 'deploy'].includes(name))
}

describe('cloudflare:deploy', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-run-'))
    scaffoldApp(root, { cfBackend: true })
    installCfTools(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function run(account: FakeAccount, calls: string[][], overrides: Partial<CloudflareDeployOptions> = {}) {
    return runCloudflareDeploy({
      root,
      skipAppBuild: true,
      cf: fakeCf(root, account, calls),
      nodeVersion: () => 'v24.22.0',
      interactive: false,
      yes: true,
      ...overrides,
    })
  }

  test('should create, settle, rebuild, migrate and deploy, in that order', async () => {
    writeMigration(root, '20261001_init', 'CREATE TABLE posts (id integer primary key);\n')
    const calls: string[][] = []

    const result = await run({ d1: [], tracker: null }, calls)

    expect(result.failure).toBeUndefined()
    expect(result.created).toEqual([{ binding: 'DB', type: 'd1', name: 'demo-app', id: NEW_DB }])
    expect(writes(calls)).toEqual(['build', 'd1 create', 'build', 'd1 time-travel', 'd1 migrations', 'deploy'])
    expect(calls).toContainEqual(['d1', 'migrations', 'apply', NEW_DB, '--dir', '.guren/cloudflare/d1-migrations'])
    expect(calls).toContainEqual(['deploy', '--prebuilt', '--no-provision'])
    expect(result.migrated).toEqual({ applied: ['20261001_init'], bookmark: '0000-bookmark' })
    expect(result.url).toBe('https://demo-app.example.workers.dev')

    const manifest = JSON.parse(readFileSync(join(root, '.guren/cloudflare/guren-worker.json'), 'utf8')) as { version: number; resolved: unknown }
    expect(manifest.resolved).toEqual({ DB: { id: NEW_DB, name: 'demo-app' } })
    expect(manifest.version).toBe(WORKER_MANIFEST_VERSION)
  })

  test('should skip creation and the rebuild when the plan already settled everything', async () => {
    const calls: string[][] = []
    await run({ d1: [{ uuid: EXISTING_DB, name: 'demo-app' }], tracker: [] }, calls)
    calls.length = 0

    const again = await run({ d1: [{ uuid: EXISTING_DB, name: 'demo-app' }], tracker: [] }, calls)

    expect(again.created).toEqual([])
    expect(writes(calls)).toEqual(['build', 'deploy'])
  })

  test('should write nothing when the plan has a blocker', async () => {
    const calls: string[][] = []

    const result = await run({ d1: [], tracker: null }, calls, { ci: true })

    expect(result.stopped).toBe('blocked')
    expect(writes(calls)).toEqual(['build'])
  })

  test('should stop at --plan, and write nothing when the person declines', async () => {
    const planned: string[][] = []
    expect((await run({ d1: [], tracker: null }, planned, { plan: true })).stopped).toBe('plan')
    expect(writes(planned)).toEqual(['build'])

    const declined: string[][] = []
    const result = await run({ d1: [], tracker: null }, declined, { interactive: true, yes: false, confirm: async () => false })
    expect(result.stopped).toBe('declined')
    expect(writes(declined)).toEqual(['build'])
  })

  test('should stop before migrating when the config binds the database elsewhere', async () => {
    writeMigration(root, '20261001_init', 'CREATE TABLE posts (id integer primary key);\n')
    const calls: string[][] = []

    const result = await run({ d1: [], tracker: null, overrideDbId: EXISTING_DB }, calls)

    expect(result.failure).toMatchObject({ stage: 'build', cleanup: [`bunx cf d1 delete ${NEW_DB}`] })
    expect(writes(calls)).toEqual(['build', 'd1 create', 'build'])
  })

  test('should migrate the database cloudflare.config.ts names by id', async () => {
    writeMigration(root, '20261001_init', 'CREATE TABLE posts (id integer primary key);\n')
    const calls: string[][] = []

    const result = await run({ d1: [{ uuid: EXISTING_DB, name: 'demo-app' }], tracker: [], configuredDbId: EXISTING_DB }, calls)

    expect(result.failure).toBeUndefined()
    expect(calls).toContainEqual(['d1', 'migrations', 'apply', EXISTING_DB, '--dir', '.guren/cloudflare/d1-migrations'])
    expect(result.migrated?.applied).toEqual(['20261001_init'])
  })

  test('should not apply when the pending set changed since the plan', async () => {
    writeMigration(root, '20261001_init', 'CREATE TABLE posts (id integer primary key);\n')
    writeMigration(root, '20261002_more', 'CREATE TABLE tags (id integer primary key);\n')
    const calls: string[][] = []

    const result = await run({
      d1: [{ uuid: EXISTING_DB, name: 'demo-app' }],
      tracker: [],
      trackerAfterPlan: ['20261001_init.sql'],
    }, calls)

    expect(result.failure?.stage).toBe('migrate')
    expect(writes(calls)).not.toContain('d1 migrations')
    expect(writes(calls)).not.toContain('deploy')
  })

  test('should not apply without a bookmark to restore to', async () => {
    writeMigration(root, '20261001_init', 'CREATE TABLE posts (id integer primary key);\n')
    const calls: string[][] = []

    const result = await run({ d1: [{ uuid: EXISTING_DB, name: 'demo-app' }], tracker: [], fail: { bookmark: 'denied' } }, calls)

    expect(result.failure?.message).toContain('No migration was applied')
    expect(writes(calls)).not.toContain('d1 migrations')
  })

  test('should report the restore and the delete commands when the deploy fails after migrating', async () => {
    writeMigration(root, '20261001_init', 'CREATE TABLE posts (id integer primary key);\n')
    const calls: string[][] = []

    const result = await run({ d1: [], tracker: null, fail: { deploy: 'upload failed' } }, calls)

    expect(result.failure).toEqual({
      stage: 'deploy',
      message: 'cf deploy failed: upload failed',
      cleanup: [`bunx cf d1 time-travel restore ${NEW_DB} --bookmark 0000-bookmark`, `bunx cf d1 delete ${NEW_DB}`],
    })
  })

  test('should report a creation whose id it could not read, and go no further', async () => {
    const calls: string[][] = []

    const result = await run({ d1: [], tracker: null, fail: { create: 'quota exceeded' } }, calls)

    expect(result.failure?.stage).toBe('provision')
    expect(result.failure?.message).toContain('adopts it')
    expect(writes(calls)).toEqual(['build', 'd1 create'])
  })

  test('should pass --secrets-file to cf as an absolute path, and skip migrations on request', async () => {
    writeMigration(root, '20261001_init', 'CREATE TABLE posts (id integer primary key);\n')
    writeFileSync(join(root, '.env.production'), 'APP_KEY=base64:x\n')
    const calls: string[][] = []

    await run({ d1: [{ uuid: EXISTING_DB, name: 'demo-app' }], tracker: [] }, calls, {
      secretsFile: join(root, '.env.production'),
      skipMigrations: true,
    })

    expect(calls).toContainEqual(['deploy', '--prebuilt', '--no-provision', '--secrets-file', join(root, '.env.production')])
    expect(writes(calls)).not.toContain('d1 migrations')
  })

  // The prompt can wait indefinitely; an edit made meanwhile was never judged.
  test('should not apply a pending migration whose text changed after the plan', async () => {
    writeMigration(root, '20261001_init', 'CREATE TABLE posts (id integer primary key);\n')
    const calls: string[][] = []

    const result = await run({ d1: [{ uuid: EXISTING_DB, name: 'demo-app' }], tracker: [] }, calls, {
      interactive: true,
      yes: false,
      confirm: async () => {
        writeMigration(root, '20261001_init', 'DROP TABLE users;\n')
        return true
      },
    })

    expect(result.failure?.stage).toBe('migrate')
    expect(writes(calls)).not.toContain('d1 migrations')
    expect(result.confirmed).toBe(true)
  })

  test('should deploy past a migration blocker under --skip-migrations, judging nothing', async () => {
    writeMigration(root, '20261001_drop', 'DROP TABLE users;\n')
    const calls: string[][] = []

    const result = await run({ d1: [{ uuid: EXISTING_DB, name: 'demo-app' }], tracker: [] }, calls, { skipMigrations: true })

    expect(result.plan.migrations).toBeUndefined()
    expect(result.failure).toBeUndefined()
    // The second build settles the adopted database; no migration command runs.
    expect(writes(calls)).toEqual(['build', 'build', 'deploy'])
  })

  test('should refuse a run with nobody to confirm before building anything', async () => {
    const calls: string[][] = []

    await expect(run({ d1: [], tracker: null }, calls, { yes: false })).rejects.toThrow(/Pass --yes/)
    expect(calls).toEqual([])
  })

  test('should keep ids settled for bindings this build does not plan, and not record a configured id', async () => {
    const path = join(root, '.guren/cloudflare/guren-worker.json')
    await run({ d1: [{ uuid: EXISTING_DB, name: 'demo-app' }], tracker: [] }, [], { plan: true })
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeJson(path, { ...manifest, resolved: { OAUTH_KV: { id: '0123456789abcdef0123456789abcdef' } } })

    // The build carries resolved over; the run then settles DB beside it.
    await run({ d1: [{ uuid: EXISTING_DB, name: 'demo-app' }], tracker: [] }, [])

    expect((JSON.parse(readFileSync(path, 'utf8')) as { resolved: unknown }).resolved).toEqual({
      OAUTH_KV: { id: '0123456789abcdef0123456789abcdef' },
      DB: { id: EXISTING_DB, name: 'demo-app' },
    })
  })
})
