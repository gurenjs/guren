import { describe, test, expect } from 'bun:test'

import type { D1Database, KvNamespace, Read } from './cf-cli'
import { autoProvisionedName, buildPlan, hasBlocker, type EvaluatedWorker, type PlanContext } from './plan'

const DB_ID = 'e902bc31-46b4-47dc-9d46-194d0b86148c'
const OTHER_DB_ID = '0b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'
const KV_ID = '0123456789abcdef0123456789abcdef'

function ok<T>(value: T): Read<T> {
  return { ok: true, value }
}

function context(overrides: Partial<PlanContext> & { env?: EvaluatedWorker['env'] } = {}): PlanContext {
  const { env, ...rest } = overrides
  return {
    worker: { name: 'demo-app', env: env ?? { DB: { type: 'd1', name: 'demo-app' } } },
    manifest: { resolved: {} },
    d1: ok<D1Database[]>([]),
    kv: ok<KvNamespace[]>([]),
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
    expect(plan.resolvedChanged).toBe(true)
  })

  test('should refuse to plan a creation the run may not perform', () => {
    const plan = buildPlan(context({ mayCreate: false }))

    expect(plan.findings.map((finding) => finding.check)).toEqual(['resource-missing'])
    expect(plan.findings[0]?.fix).toContain('--provision')
    expect(hasBlocker(plan)).toBe(true)
  })

  test('should adopt a resource found by name that the manifest has not resolved', () => {
    const plan = buildPlan(context({ d1: ok([{ uuid: DB_ID, name: 'demo-app' }]) }))

    expect(plan.bindings[0]).toMatchObject({ action: 'adopt', id: DB_ID })
    expect(plan.resolvedChanged).toBe(true)
  })

  test('should report nothing changed when the listing matches the resolved resource', () => {
    const plan = buildPlan(context({
      d1: ok([{ uuid: DB_ID, name: 'demo-app' }]),
      manifest: { resolved: { DB: { id: DB_ID, name: 'demo-app' } } },
      env: { DB: { type: 'd1', name: 'demo-app', id: DB_ID } },
    }))

    expect(plan.bindings[0]).toMatchObject({ action: 'existing', id: DB_ID })
    expect(plan.findings).toEqual([])
    expect(plan.resolvedChanged).toBe(false)
  })

  test('should match names exactly, since the account listing is a search', () => {
    const plan = buildPlan(context({ d1: ok([{ uuid: DB_ID, name: 'demo-app-staging' }]) }))

    expect(plan.bindings[0]?.action).toBe('create')
  })

  test('should resolve KV by the provisioning name, which it cannot carry itself', () => {
    const plan = buildPlan(context({
      env: { OAUTH_KV: { type: 'kv' } },
      kv: ok([{ id: KV_ID, title: 'demo-app-oauth-kv' }]),
    }))

    expect(plan.bindings).toEqual([{ binding: 'OAUTH_KV', type: 'kv', action: 'adopt', name: 'demo-app-oauth-kv', id: KV_ID }])
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
      d1: ok([{ uuid: DB_ID, name: 'legacy' }]),
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
      d1: ok([{ uuid: DB_ID, name: 'demo-app' }, { uuid: OTHER_DB_ID, name: 'demo-app' }]),
    }))

    expect(plan.bindings[0]).toMatchObject({ action: 'existing', id: DB_ID })
    expect(plan.findings).toEqual([])
  })

  test('should keep a resolved namespace whose title changed', () => {
    const plan = buildPlan(context({
      env: { OAUTH_KV: { type: 'kv', id: KV_ID } },
      manifest: { resolved: { OAUTH_KV: { id: KV_ID } } },
      kv: ok([{ id: KV_ID, title: 'renamed' }]),
      mayCreate: false,
    }))

    expect(plan.bindings[0]).toMatchObject({ action: 'existing', id: KV_ID })
    expect(plan.findings).toEqual([])
  })

  test('should block when the resolved resource and the planned name differ', () => {
    const plan = buildPlan(context({
      env: { DB: { type: 'd1', name: 'demo-app', id: DB_ID } },
      manifest: { resolved: { DB: { id: DB_ID, name: 'legacy' } } },
      d1: ok([{ uuid: DB_ID, name: 'legacy' }, { uuid: OTHER_DB_ID, name: 'demo-app' }]),
    }))

    expect(plan.findings.map((finding) => finding.check)).toEqual(['binding-conflict'])
  })

  test('should block when the configured id and the name point at different databases', () => {
    const plan = buildPlan(context({
      env: { DB: { type: 'd1', name: 'demo-app', id: DB_ID } },
      d1: ok([{ uuid: DB_ID, name: 'legacy' }, { uuid: OTHER_DB_ID, name: 'demo-app' }]),
    }))

    expect(plan.findings.map((finding) => finding.check)).toEqual(['binding-conflict'])
    expect(plan.findings[0]?.message).toContain(OTHER_DB_ID)
  })

  // An id gurenWorker() emitted from the manifest is a comparison, not a configured source.
  test('should not take the manifest\'s own id for one the developer configured', () => {
    const plan = buildPlan(context({
      env: { DB: { type: 'd1', name: 'demo-app', id: DB_ID } },
      manifest: { resolved: { DB: { id: DB_ID, name: 'demo-app' } } },
      d1: ok([{ uuid: OTHER_DB_ID, name: 'demo-app' }]),
    }))

    expect(plan.bindings[0]).toMatchObject({ action: 'adopt', id: OTHER_DB_ID })
    expect(plan.findings).toEqual([])
    expect(plan.resolvedChanged).toBe(true)
  })

  test('should block when two databases share the planned name', () => {
    const plan = buildPlan(context({
      d1: ok([{ uuid: DB_ID, name: 'demo-app' }, { uuid: OTHER_DB_ID, name: 'demo-app' }]),
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
})
