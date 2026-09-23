import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { runCheck, type CheckResult } from '../src/check'
import { analyzeDeployRuntime, checkDeployRuntime } from '../src/deploy-runtime'
import { getDoctorRuleEvaluations } from '../src/doctor'
import { assertWorkspaceBuilt, createTempRoot, linkWorkspaceCore, SERVER_DIST_ENTRY, writeWorkspaceFiles } from './helpers'

const ENTRY = "import app from './app.js'\n\nexport default app\n"

const ARGON2_APP = `import { createApp } from '@guren/core'

export default createApp({ auth: { hasher: 'argon2' } })
`

/** Binds nothing, then throws where a Workers-only provider would reach for a binding. */
const THROWING_APP = `import { createApp, ServiceProvider } from '@guren/core'

class AuthProvider extends ServiceProvider {
  register(): void {
    throw new Error('env.DB is not bound outside workerd')
  }
}

export default createApp({ auth: {}, providers: [AuthProvider] })
`

let root: string

/** One directory per scenario: `introspectApp()` memoises per app root for the whole test process. */
async function cloudflareApp(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(root, name)
  await linkWorkspaceCore(dir)
  await writeWorkspaceFiles(dir, {
    // Bun otherwise installs an unresolvable specifier from npm instead of failing.
    'bunfig.toml': '[install]\nauto = "disable"\n',
    'package.json': JSON.stringify({ name: name, type: 'module', dependencies: { '@guren/plugin-cloudflare': '^0.11.0' } }),
    'src/main.ts': ENTRY,
    ...files,
  })
  return dir
}

function byKey(checks: CheckResult[]): Record<string, CheckResult> {
  return Object.fromEntries(checks.filter((result) => /^(deploy-|introspection-)/.test(result.key)).map((result) => [result.key, result]))
}

beforeAll(async () => {
  assertWorkspaceBuilt([SERVER_DIST_ENTRY])
  root = await createTempRoot('guren-deploy-introspect-test-')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('deploy-runtime verdicts read from the introspected app (RFC 0026 §5)', () => {
  test('warns on an argon2 hasher from the manifest, as the scan does from source', async () => {
    const dir = await cloudflareApp('argon2', { 'src/app.ts': ARGON2_APP })

    const manifest = byKey((await runCheck({ cwd: dir, introspect: true })).checks)
    expect(manifest['introspection-unavailable']).toBeUndefined()
    expect(manifest['deploy-password-hashing']).toMatchObject({ status: 'warn', evidence: 'manifest', advisory: true })
    expect(manifest['deploy-password-hashing'].message).toContain('createApp({ auth }): DefaultHasher (argon2)')
    expect(manifest['deploy-provider-discovery'].evidence).toBe('static')

    const source = byKey((await runCheck({ cwd: dir, introspect: false })).checks)
    expect(source['deploy-password-hashing']).toMatchObject({ status: 'warn', evidence: 'static' })
    expect(source['deploy-password-hashing'].message).toContain("auth.hasher: 'argon2' (src/app.ts:3)")
  })

  test('reports the same verdicts through doctor, and through checkDeployRuntime() as a deploy build calls it', async () => {
    const dir = await cloudflareApp('argon2-parity', { 'src/app.ts': ARGON2_APP })

    const fromCheck = byKey((await runCheck({ cwd: dir, introspect: true })).checks)
    const { evaluations } = await getDoctorRuleEvaluations({ cwd: dir, introspect: true })
    const verdicts = await checkDeployRuntime(dir)

    expect(verdicts.map((verdict) => verdict.evidence)).toEqual(['manifest', 'manifest', 'static'])
    // An options object that does not name `introspect` keeps the default.
    expect((await checkDeployRuntime(dir, {}))[0].evidence).toBe('manifest')
    for (const verdict of verdicts) {
      const doctor = evaluations.find((evaluation) => evaluation.check.key === verdict.key)?.check
      expect(doctor).toMatchObject({ status: verdict.status, message: verdict.message, evidence: verdict.evidence })
      expect(fromCheck[verdict.key]).toMatchObject({ status: verdict.status, message: verdict.message, evidence: verdict.evidence })
    }

    const { evaluations: source } = await getDoctorRuleEvaluations({ cwd: dir, introspect: false })
    expect(source.find((evaluation) => evaluation.check.key === 'deploy-password-hashing')?.check.evidence).toBe('static')
  })

  test('falls back to the scan, and says why once, when the entry does not import', async () => {
    const dir = await cloudflareApp('broken-entry', {
      'src/app.ts': ARGON2_APP,
      'src/main.ts': "import app from './app.js'\nimport './missing-module.js'\n\nexport default app\n",
    })

    const checks = byKey((await runCheck({ cwd: dir, introspect: true })).checks)
    expect(checks['introspection-unavailable']).toMatchObject({ status: 'warn', advisory: true })
    expect(checks['introspection-unavailable'].message).toContain('(import)')
    expect(checks['deploy-password-hashing']).toMatchObject({ status: 'warn', evidence: 'static' })
    expect(checks['deploy-password-hashing'].message).toContain("auth.hasher: 'argon2'")

    const skipped = byKey((await runCheck({ cwd: dir, introspect: false })).checks)
    expect(skipped['introspection-unavailable']).toBeUndefined()
  })

  test('never passes what a provider that threw may have configured', async () => {
    const dir = await cloudflareApp('threw', { 'src/app.ts': THROWING_APP })

    const checks = byKey((await runCheck({ cwd: dir, introspect: true })).checks)
    expect(checks['deploy-password-hashing']).toBeUndefined()
    expect(checks['deploy-password-hashing-unverified']).toMatchObject({ status: 'warn', evidence: 'none', advisory: true })
    expect(checks['deploy-password-hashing-unverified'].message).toContain('AuthProvider threw in register()')
    expect(checks['deploy-runtime-stores-unverified']).toMatchObject({ status: 'warn', evidence: 'none' })

    // The scan finds no password authentication in this source and passes it.
    const source = byKey((await runCheck({ cwd: dir, introspect: false })).checks)
    expect(source['deploy-password-hashing']).toMatchObject({ status: 'pass', evidence: 'static' })
  })

  test('does not introspect an app with no deploy target', async () => {
    const dir = await cloudflareApp('no-target', { 'package.json': JSON.stringify({ name: 'no-target', type: 'module' }) })

    const analysis = await analyzeDeployRuntime(dir, {
      introspect: () => {
        throw new Error('introspected an app with no deploy target')
      },
    })
    expect(analysis.targets).toEqual([])
  })
})
