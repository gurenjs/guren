import { describe, test, expect } from 'bun:test'

import {
  cfBuild,
  checkAuth,
  listD1Databases,
  listKvNamespaces,
  listWorkerSecrets,
  readMigrationTracker,
  type CliResult,
  type CliRunner,
} from './cf-cli'

/** A runner answering from a script of results, recording each argv. */
function scripted(results: CliResult[]): CliRunner & { calls: string[][] } {
  const calls: string[][] = []
  const runner = ((args: string[]) => {
    calls.push(args)
    return results[calls.length - 1] ?? { exitCode: 1, stdout: '', stderr: 'unexpected call' }
  }) as CliRunner & { calls: string[][] }
  runner.calls = calls
  return runner
}

function json(value: unknown): CliResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' }
}

const fullPage = Array.from({ length: 100 }, (_, index) => ({ uuid: `id-${index}`, name: `db-${index}` }))

describe('cf CLI wrappers', () => {
  test('should list D1 with explicit paging, the argv the GUREN_TEST_CF probe checks', () => {
    const cf = scripted([json([{ uuid: 'a', name: 'demo-app', version: 'production' }])])

    expect(listD1Databases(cf)).toEqual({ ok: true, value: [{ id: 'a', name: 'demo-app' }] })
    expect(cf.calls).toEqual([['d1', 'list', '--page', '1', '--per-page', '100']])
  })

  // cf prints `result` and drops `result_info`, so a full page is the only sign of another.
  test('should follow full pages until a short one', () => {
    const cf = scripted([json(fullPage), json([{ uuid: 'last', name: 'last' }])])

    const listing = listD1Databases(cf)

    expect(listing.ok && listing.value.length).toBe(101)
    expect(cf.calls[1]).toEqual(['d1', 'list', '--page', '2', '--per-page', '100'])
  })

  test('should report a failing listing as unreadable, never as empty', () => {
    const cf = scripted([{ exitCode: 1, stdout: '', stderr: 'Authentication error [code: 10000]' }])

    expect(listD1Databases(cf)).toEqual({ ok: false, reason: 'cf d1 list failed: Authentication error [code: 10000]' })
  })

  test('should accept the API envelope, and report output that is no JSON list as unreadable', () => {
    expect(listKvNamespaces(scripted([{ exitCode: 0, stdout: '{"result":[]}', stderr: '' }])).ok).toBe(true)
    expect(listKvNamespaces(scripted([{ exitCode: 0, stdout: '{"errors":[]}', stderr: '' }])).ok).toBe(false)
    expect(listKvNamespaces(scripted([{ exitCode: 0, stdout: 'Listing namespaces...', stderr: '' }])).ok).toBe(false)
  })

  test('should report an entry of another shape as unreadable', () => {
    const listing = listKvNamespaces(scripted([json([{ id: 'x', name: 'not-title' }])]))

    expect(listing.ok).toBe(false)
  })

  test('should list KV namespaces by id and title', () => {
    const cf = scripted([json([{ id: 'k', title: 'demo-app-oauth-kv', supports_url_encoding: true }])])

    expect(listKvNamespaces(cf)).toEqual({ ok: true, value: [{ id: 'k', name: 'demo-app-oauth-kv' }] })
    expect(cf.calls).toEqual([['kv', 'namespaces', 'list', '--page', '1', '--per-page', '100']])
  })

  // `cf auth whoami` exits 0 when logged out (measured on 1.0.0-beta.18).
  test('should read the authenticated flag rather than the exit code', () => {
    expect(checkAuth(scripted([json({ authenticated: false, error: 'Not logged in' })]))).toEqual({
      ok: false,
      reason: 'Not logged in',
    })
    expect(checkAuth(scripted([json({ authenticated: true })]))).toEqual({ ok: true, value: true })
    expect(checkAuth(scripted([{ exitCode: 0, stdout: 'hello', stderr: '' }])).ok).toBe(false)
  })

  test('should pass cf build\'s output through on failure', () => {
    expect(cfBuild(scripted([{ exitCode: 1, stdout: '', stderr: 'Invalid `cloudflare.config.ts`' }]))).toEqual({
      ok: false,
      reason: 'Invalid `cloudflare.config.ts`',
    })
  })

  test('should read the tracker rows, with or without the API envelope', () => {
    const rows = [{ results: [{ name: '20261001_init.sql' }, { name: '20261002_posts.sql' }], success: true }]
    const cf = scripted([json(rows), json({ success: true, result: rows })])

    expect(readMigrationTracker(cf, 'db-id')).toEqual({ ok: true, value: ['20261001_init.sql', '20261002_posts.sql'] })
    expect(readMigrationTracker(cf, 'db-id')).toEqual({ ok: true, value: ['20261001_init.sql', '20261002_posts.sql'] })
    expect(cf.calls[0]).toEqual(['d1', 'query', 'db-id', '--sql', 'select name from d1_migrations order by id'])
  })

  test('should read a missing tracker table as nothing applied, and any other failure as unreadable', () => {
    const missing = scripted([{ exitCode: 1, stdout: '', stderr: 'D1_ERROR: no such table: d1_migrations: SQLITE_ERROR' }])
    const denied = scripted([{ exitCode: 1, stdout: '', stderr: 'Authentication error [code: 10000]' }])

    expect(readMigrationTracker(missing, 'db-id')).toEqual({ ok: true, value: null })
    expect(readMigrationTracker(denied, 'db-id').ok).toBe(false)
    expect(readMigrationTracker(scripted([json([{ success: true }])]), 'db-id').ok).toBe(false)
  })

  test('should list secret names for one worker', () => {
    const cf = scripted([json([{ name: 'APP_KEY', type: 'secret_text' }]), json({ result: [{ name: 'B', type: 'secret_text' }] })])

    expect(listWorkerSecrets(cf, 'demo-app')).toEqual({ ok: true, value: ['APP_KEY'] })
    expect(listWorkerSecrets(cf, 'demo-app')).toEqual({ ok: true, value: ['B'] })
    expect(cf.calls[0]).toEqual(['workers', 'secrets', 'list', '--worker', 'demo-app'])
    expect(listWorkerSecrets(scripted([{ exitCode: 1, stdout: '', stderr: 'workers.api.error.script_not_found' }]), 'x').ok).toBe(false)
  })
})
