import { describe, test, expect } from 'bun:test'

import type { AccountResource, Read } from './cf-cli'
import { autoProvisionedName } from '../worker-manifest'
import { buildPlan, hasBlocker, type EvaluatedWorker, type PlanContext } from './plan'

const DB_ID = 'e902bc31-46b4-47dc-9d46-194d0b86148c'
const OTHER_DB_ID = '0b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'
const KV_ID = '0123456789abcdef0123456789abcdef'

function ok<T>(value: T): Read<T> {
  return { ok: true, value }
}

function context(overrides: Partial<PlanContext> & { env?: EvaluatedWorker['env'] } = {}): PlanContext {
  const { env, ...rest } = overrides
  return {
    backend: 'cf',
    worker: { name: 'demo-app', env: env ?? { DB: { type: 'd1', name: 'demo-app' } } },
    manifest: { resolved: {} },
    d1: ok<AccountResource[]>([]),
    kv: ok<AccountResource[]>([]),
    mayCreate: true,
    ...rest,
  }
}

describe('buildPlan', () => {
  test('should name an auto-provisioned resource as cf does', () => {
    expect(autoProvisionedName('demo-app', 'OAUTH_KV')).toBe('demo-app-oauth-kv')
  })

  test('should plan a missing database for creation under its binding name', () => {
    const plan = buildPlan(context())

    expect(plan.bindings).toEqual([{ binding: 'DB', type: 'd1', action: 'create', name: 'demo-app' }])
    expect(plan.findings).toEqual([])
  })

  test('should refuse to plan a creation the run may not perform', () => {
    const plan = buildPlan(context({ mayCreate: false }))

    expect(plan.findings.map((finding) => finding.check)).toEqual(['resource-missing'])
    expect(plan.findings[0]?.fix).toContain('--provision')
    expect(hasBlocker(plan)).toBe(true)
  })

  test('should adopt a resource found by name that the manifest has not resolved', () => {
    const plan = buildPlan(context({ d1: ok([{ id: DB_ID, name: 'demo-app' }]) }))

    expect(plan.bindings[0]).toMatchObject({ action: 'adopt', id: DB_ID })
  })

  test('should report nothing changed when the listing matches the resolved resource', () => {
    const plan = buildPlan(context({
      d1: ok([{ id: DB_ID, name: 'demo-app' }]),
      manifest: { resolved: { DB: { id: DB_ID, name: 'demo-app' } } },
      env: { DB: { type: 'd1', name: 'demo-app', id: DB_ID } },
    }))

    expect(plan.bindings[0]).toMatchObject({ action: 'existing', id: DB_ID })
    expect(plan.findings).toEqual([])
  })

  test('should match names exactly, since the account listing is a search', () => {
    const plan = buildPlan(context({ d1: ok([{ id: DB_ID, name: 'demo-app-staging' }]) }))

    expect(plan.bindings[0]?.action).toBe('create')
  })

  test('should resolve KV by the provisioning name, which it cannot carry itself', () => {
    const plan = buildPlan(context({
      env: { OAUTH_KV: { type: 'kv' } },
      kv: ok([{ id: KV_ID, name: 'demo-app-oauth-kv' }]),
    }))

    expect(plan.bindings).toEqual([{ binding: 'OAUTH_KV', type: 'kv', action: 'adopt', name: 'demo-app-oauth-kv', id: KV_ID }])
  })

  test('should resolve KV under the name config/cloudflare.ts gives it', () => {
    const plan = buildPlan(context({
      env: { OAUTH_KV: { type: 'kv' } },
      manifest: { resolved: {}, resourceNames: { OAUTH_KV: 'shared-oauth' } },
      kv: ok([{ id: KV_ID, name: 'shared-oauth' }]),
    }))

    expect(plan.bindings[0]).toMatchObject({ action: 'adopt', name: 'shared-oauth', id: KV_ID })
  })

  // The deploy binds the settled id, so a new name would be shown and not bound.
  test('should block a resource name changed after an earlier deploy settled the binding', () => {
    const plan = buildPlan(context({
      env: { DB: { type: 'd1', name: 'demo-app', id: DB_ID } },
      manifest: { resolved: { DB: { id: DB_ID, name: 'demo-app' } }, resourceNames: { DB: 'demo-db' } },
      d1: ok([{ id: DB_ID, name: 'demo-app' }]),
    }))

    expect(plan.findings.map((finding) => finding.check)).toEqual(['binding-conflict'])
    expect(plan.findings[0]?.fix).toContain('delete DB from "resolved"')
  })

  test('should leave bindings it does not provision out of the plan', () => {
    const plan = buildPlan(context({
      env: {
        NODE_ENV: { type: 'text' },
        TRIAGER: { type: 'durable-object' },
      },
    }))

    expect(plan.bindings).toEqual([])
  })

  test('should accept an id the config names when the account has it', () => {
    const plan = buildPlan(context({
      env: { DB: { type: 'd1', name: 'legacy', id: DB_ID } },
      d1: ok([{ id: DB_ID, name: 'legacy' }]),
    }))

    expect(plan.bindings[0]).toMatchObject({ action: 'existing', id: DB_ID })
    expect(plan.findings).toEqual([])
  })

  test('should block an id the config names that the account does not have', () => {
    const plan = buildPlan(context({ env: { DB: { type: 'd1', name: 'demo-app', id: DB_ID } } }))

    expect(plan.findings.map((finding) => finding.check)).toEqual(['resource-missing'])
    expect(plan.bindings[0]?.action).toBe('unknown')
  })

  // gurenWorker() writes the manifest's id into the config, so the deploy binds it while it exists.
  test('should keep the resolved resource among several of the same name', () => {
    const plan = buildPlan(context({
      env: { DB: { type: 'd1', name: 'demo-app', id: DB_ID } },
      manifest: { resolved: { DB: { id: DB_ID, name: 'demo-app' } } },
      d1: ok([{ id: DB_ID, name: 'demo-app' }, { id: OTHER_DB_ID, name: 'demo-app' }]),
    }))

    expect(plan.bindings[0]).toMatchObject({ action: 'existing', id: DB_ID })
    expect(plan.findings).toEqual([])
  })

  test('should keep a resolved namespace whose title changed', () => {
    const plan = buildPlan(context({
      env: { OAUTH_KV: { type: 'kv', id: KV_ID } },
      manifest: { resolved: { OAUTH_KV: { id: KV_ID } } },
      kv: ok([{ id: KV_ID, name: 'renamed' }]),
      mayCreate: false,
    }))

    expect(plan.bindings[0]).toMatchObject({ action: 'existing', id: KV_ID })
    expect(plan.findings).toEqual([])
  })

  test('should block when the resolved resource and the planned name differ', () => {
    const plan = buildPlan(context({
      env: { DB: { type: 'd1', name: 'demo-app', id: DB_ID } },
      manifest: { resolved: { DB: { id: DB_ID, name: 'legacy' } } },
      d1: ok([{ id: DB_ID, name: 'legacy' }, { id: OTHER_DB_ID, name: 'demo-app' }]),
    }))

    expect(plan.findings.map((finding) => finding.check)).toEqual(['binding-conflict'])
  })

  test('should block when the configured id and the name point at different databases', () => {
    const plan = buildPlan(context({
      env: { DB: { type: 'd1', name: 'demo-app', id: DB_ID } },
      d1: ok([{ id: DB_ID, name: 'legacy' }, { id: OTHER_DB_ID, name: 'demo-app' }]),
    }))

    expect(plan.findings.map((finding) => finding.check)).toEqual(['binding-conflict'])
    expect(plan.findings[0]?.message).toContain(OTHER_DB_ID)
  })

  // An id gurenWorker() emitted from the manifest is a comparison, not a configured source.
  test('should not take the manifest\'s own id for one the developer configured', () => {
    const plan = buildPlan(context({
      env: { DB: { type: 'd1', name: 'demo-app', id: DB_ID } },
      manifest: { resolved: { DB: { id: DB_ID, name: 'demo-app' } } },
      d1: ok([{ id: OTHER_DB_ID, name: 'demo-app' }]),
    }))

    expect(plan.bindings[0]).toMatchObject({ action: 'adopt', id: OTHER_DB_ID })
    expect(plan.findings).toEqual([])
  })

  test('should block when two databases share the planned name', () => {
    const plan = buildPlan(context({
      d1: ok([{ id: DB_ID, name: 'demo-app' }, { id: OTHER_DB_ID, name: 'demo-app' }]),
    }))

    expect(plan.bindings[0]?.action).toBe('unknown')
    expect(plan.findings.map((finding) => finding.check)).toEqual(['binding-conflict'])
  })

  test('should block on a listing it could not read rather than plan a creation', () => {
    const plan = buildPlan(context({ d1: { ok: false, reason: 'cf d1 list failed: 403' } }))

    expect(plan.bindings[0]?.action).toBe('unknown')
    expect(plan.findings.map((finding) => finding.check)).toEqual(['source-unreadable'])
    expect(plan.findings[0]?.message).toContain('403')
  })

  test('should not block on an unreadable listing no binding needs', () => {
    const plan = buildPlan(context({ kv: { ok: false, reason: 'cf kv namespaces list failed' } }))

    expect(plan.findings).toEqual([])
  })

  test('should say which source it did not read', () => {
    expect(buildPlan(context()).unread.join(' ')).toContain('deployed Worker')
  })

  describe('migrations', () => {
    const ready = {
      status: 'ready' as const,
      layout: 'flat' as const,
      applyArgs: ['--dir', '.guren/cloudflare/d1-migrations'],
      pending: ['20261002_drop'],
      unjudged: [],
      verdict: { unacknowledged: [], acknowledged: [] },
      allowDestructive: false,
      fingerprint: 'f',
    }

    test('should report the pending set and how it applies', () => {
      const plan = buildPlan(context({ migrations: ready }))

      expect(plan.migrations).toEqual({ layout: 'flat', pending: ['20261002_drop'], applyArgs: ready.applyArgs, acknowledged: [], fingerprint: 'f' })
      expect(plan.findings).toEqual([])
    })

    test('should block a destructive statement no marker covers, and only warn under --allow-destructive', () => {
      const verdict = { unacknowledged: ['db/migrations/20261002_drop/migration.sql:1: drops table posts (drop-table)'], acknowledged: [] }

      const refused = buildPlan(context({ migrations: { ...ready, verdict } }))
      const allowed = buildPlan(context({ migrations: { ...ready, verdict, allowDestructive: true } }))

      expect(refused.findings.map((finding) => [finding.check, finding.severity])).toEqual([['destructive-migration', 'blocker']])
      expect(refused.findings[0]?.message).toContain('migration.sql:1')
      expect(allowed.findings.map((finding) => finding.severity)).toEqual(['warning'])
    })

    test('should block a pending plain .sql file the guard cannot read', () => {
      const plan = buildPlan(context({ migrations: { ...ready, unjudged: ['0001_legacy.sql'] } }))

      expect(plan.findings[0]?.message).toContain('0001_legacy.sql')
      expect(hasBlocker(plan)).toBe(true)
    })

    test('should block a tracker on both layouts, and one it could not read', () => {
      expect(buildPlan(context({ migrations: { status: 'layout-conflict', nested: ['a/migration.sql'], flat: ['b.sql'] } })).findings[0]?.check)
        .toBe('tracker-layout')
      expect(buildPlan(context({ migrations: { status: 'unreadable', reason: 'cf d1 query failed' } })).findings[0]?.check)
        .toBe('source-unreadable')
    })
  })

  describe('secrets', () => {
    const required = { status: 'loaded' as const, required: ['APP_KEY', 'APP_URL'] }

    test('should accept names the deployed worker, the config or the secrets file provide', () => {
      const plan = buildPlan(context({ secrets: { required, deployed: ok(['APP_KEY']), provided: ['APP_URL'] } }))

      expect(plan.missingSecrets).toEqual([])
      expect(plan.findings).toEqual([])
    })

    test('should block a missing secret, naming the command that sets it', () => {
      const plan = buildPlan(context({ secrets: { required, deployed: ok(['APP_KEY']), provided: [] } }))

      expect(plan.missingSecrets).toEqual(['APP_URL'])
      expect(plan.findings[0]?.fix).toBe('bunx cf workers secrets update APP_URL --worker demo-app')
    })

    // A first deploy has no worker to list secrets of; only the file can provide them.
    test('should send a first deploy to --secrets-file when the deployed secrets cannot be read', () => {
      const plan = buildPlan(context({
        secrets: { required, deployed: { ok: false, reason: 'script not found' }, provided: ['APP_KEY'], secretsFile: '.env.production' },
      }))

      expect(plan.missingSecrets).toEqual(['APP_URL'])
      expect(plan.findings[0]?.message).toContain('script not found')
      expect(plan.findings[0]?.fix).toContain('.env.production lacks them')
    })

    test('should need nothing without config/env.ts, and block when it cannot be read', () => {
      const absent = buildPlan(context({ secrets: { required: { status: 'absent' }, deployed: ok([]), provided: [] } }))
      expect(absent.findings).toEqual([])
      // Unchecked, so the report does not claim every variable is provided.
      expect(absent.missingSecrets).toBeUndefined()
      expect(buildPlan(context({ secrets: { required: { status: 'unreadable', message: 'config/env.ts failed to import' }, deployed: ok([]), provided: [] } })).findings[0]?.check)
        .toBe('source-unreadable')
    })
  })

  describe('serialization', () => {
    test('should warn, never block, when the deploy workflow has no concurrency group', () => {
      const plan = buildPlan(context({ workflow: ok('on: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n') }))

      expect(plan.findings.map((finding) => [finding.check, finding.severity])).toEqual([['serialization', 'warning']])
      expect(plan.findings[0]?.fix).toContain('cloudflare-deploy-demo-app')
      expect(hasBlocker(plan)).toBe(false)
    })

    test('should warn when the group cancels a running deploy, or only a job sets one', () => {
      const cancelling = 'concurrency:\n  group: deploy\n  cancel-in-progress: true\n'
      const jobOnly = 'jobs:\n  lint:\n    concurrency: lint\n    runs-on: ubuntu-latest\n'

      expect(buildPlan(context({ workflow: ok(cancelling) })).findings[0]?.check).toBe('serialization')
      expect(buildPlan(context({ workflow: ok(jobOnly) })).findings[0]?.check).toBe('serialization')
    })

    test('should accept a workflow with a concurrency group, and say so when it could not read one', () => {
      expect(buildPlan(context({ workflow: ok('concurrency:\n  group: cloudflare-deploy-demo-app\n  cancel-in-progress: false\n') })).findings).toEqual([])
      expect(buildPlan(context({ workflow: ok('concurrency: deploy\n') })).findings).toEqual([])
      expect(buildPlan(context({ workflow: { ok: false, reason: 'ENOENT' } })).findings[0]?.message).toContain('ENOENT')
      expect(buildPlan(context()).findings).toEqual([])
    })
  })

  // Deploying a Worker without the trigger it had removes it.
  test('should block on an unreadable schedule kernel unless the config sets its own trigger', () => {
    const unreadable = 'app/Console/Kernel.ts could not be read (failed: kernel broke)'

    expect(buildPlan(context({ scheduleUnreadable: unreadable })).findings.map((finding) => finding.check)).toEqual(['schedule-unreadable'])
    expect(buildPlan(context({
      scheduleUnreadable: unreadable,
      worker: { name: 'demo-app', env: { DB: { type: 'd1', name: 'demo-app' } }, scheduled: true },
    })).findings).toEqual([])
  })
})

describe('R2 buckets and what the app names (RFC 0035 §2)', () => {
  const r2Env = { DB: { type: 'd1', name: 'demo-app' }, MEDIA: { type: 'r2', name: 'demo-app-media' } }

  test('should create, adopt or keep an R2 bucket by its name', () => {
    const create = buildPlan(context({ env: r2Env, r2: ok<AccountResource[]>([]) }))
    expect(create.bindings.find((binding) => binding.binding === 'MEDIA')).toEqual({ binding: 'MEDIA', type: 'r2', action: 'create', name: 'demo-app-media' })

    const adopt = buildPlan(context({ env: r2Env, r2: ok([{ id: 'demo-app-media', name: 'demo-app-media' }]) }))
    expect(adopt.bindings.find((binding) => binding.binding === 'MEDIA')).toMatchObject({ action: 'adopt', id: 'demo-app-media' })

    const existing = buildPlan(context({
      env: r2Env,
      r2: ok([{ id: 'demo-app-media', name: 'demo-app-media' }]),
      manifest: { resolved: { MEDIA: { id: 'demo-app-media', name: 'demo-app-media' } } },
    }))
    expect(existing.bindings.find((binding) => binding.binding === 'MEDIA')).toMatchObject({ action: 'existing' })
    expect(hasBlocker(existing)).toBe(false)
  })

  test('should leave R2 to the deploy when the backend cannot list buckets', () => {
    const plan = buildPlan(context({ backend: 'wrangler', env: r2Env }))
    expect(plan.bindings.map((binding) => binding.binding)).toEqual(['DB'])
    expect(hasBlocker(plan)).toBe(false)
  })

  test('should refuse an R2 bucket name R2 would reject, before anything is created', () => {
    const plan = buildPlan(context({ env: { MEDIA: { type: 'r2', name: 'Demo_App.Media' } }, r2: ok<AccountResource[]>([]) }))
    expect(plan.findings).toContainEqual(expect.objectContaining({ check: 'resource-name', binding: 'MEDIA', severity: 'blocker' }))
  })

  test('should block a bucket a disk reads and the Worker lacks, in the backend\'s own words', () => {
    const inference = { r2Buckets: ['MEDIA'] }
    const cf = buildPlan(context({ inference, r2: ok<AccountResource[]>([]) }))
    expect(cf.findings).toContainEqual(expect.objectContaining({ check: 'resource-missing', binding: 'MEDIA', fix: expect.stringContaining('gurenWorker() binds MEDIA') }))

    const wrangler = buildPlan(context({ backend: 'wrangler', inference }))
    expect(wrangler.findings).toContainEqual(expect.objectContaining({
      check: 'resource-missing',
      fix: expect.stringContaining('"r2_buckets": [{ "binding": "MEDIA", "bucket_name": "demo-app-media" }]'),
    }))
  })

  test('should block a D1 binding config/database.ts names and the Worker does not bind', () => {
    const plan = buildPlan(context({ inference: { r2Buckets: [], databaseBinding: 'DATABASE' } }))
    expect(plan.findings).toContainEqual(expect.objectContaining({ check: 'binding-conflict', binding: 'DATABASE' }))
    expect(hasBlocker(buildPlan(context({ inference: { r2Buckets: [], databaseBinding: 'DB' } })))).toBe(false)
  })

  test('should warn about a resource name for a binding the Worker does not have, such as a misspelt one', () => {
    const plan = buildPlan(context({ manifest: { resolved: {}, resourceNames: { db: 'shared-db' } } }))
    expect(plan.findings).toContainEqual(expect.objectContaining({ check: 'resource-name', severity: 'warning', binding: 'db' }))
    expect(hasBlocker(plan)).toBe(false)
  })

  test('should list what could not be inferred without blocking', () => {
    const plan = buildPlan(context({ inference: { r2Buckets: [], unread: 'introspection failed with import', opaqueDisks: ['media'] } }))
    expect(hasBlocker(plan)).toBe(false)
    expect(plan.unread.join('\n')).toContain('introspection failed with import')
    expect(plan.unread.join('\n')).toContain('r2Disk()')
  })
})
