import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { runCheck, type CheckResult } from '../src/check'
import { gatingResults } from '../src/check-result'
import { checkDeployRuntime, readDeployRuntime } from '../src/deploy-runtime'
import { getDoctorRuleEvaluations } from '../src/doctor'
import { assertWorkspaceBuilt, createTempRoot, linkWorkspaceCore, runCliBinCaptured, SERVER_DIST_ENTRY, writeWorkspaceFiles } from './helpers'

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

/** Reads an env key without a default, which a CI build with no .env leaves unset. */
const UNSET_ENV_APP = `import { createApp, defineEnv, defineSessionConfig, Env } from '@guren/core'

const env = defineEnv({ RFC26_UNSET_SESSION_DRIVER: Env.string() })

const session = defineSessionConfig((values) => ({
  default: (values as unknown as Record<string, string>).RFC26_UNSET_SESSION_DRIVER,
  stores: { cookie: { driver: 'cookie' } },
}))

export default createApp({ env, config: [session], auth: {} })
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

/** `guren doctor --json` prints its report twice; the first document is enough. */
function firstJsonDocument(output: string): string {
  const start = output.indexOf('{')
  let depth = 0
  for (let index = start; index < output.length; index++) {
    if (output[index] === '{') depth++
    else if (output[index] === '}' && --depth === 0) return output.slice(start, index + 1)
  }
  throw new Error(`no JSON document in: ${output.slice(0, 200)}`)
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
  test('warns on an argon2 hasher from the manifest, and cannot vouch for it without one', async () => {
    const dir = await cloudflareApp('argon2', { 'src/app.ts': ARGON2_APP })

    const manifest = byKey((await runCheck({ cwd: dir, introspect: true })).checks)
    expect(manifest['introspection-unavailable']).toBeUndefined()
    expect(manifest['deploy-password-hashing']).toMatchObject({ status: 'warn', evidence: 'manifest', advisory: true })
    expect(manifest['deploy-password-hashing'].message).toContain('createApp({ auth }): DefaultHasher (argon2)')
    expect(manifest['deploy-provider-discovery'].evidence).toBe('static')

    const source = byKey((await runCheck({ cwd: dir, introspect: false })).checks)
    expect(source['deploy-password-hashing-unverified']).toMatchObject({ status: 'warn', evidence: 'none', advisory: true })
    expect(source['deploy-password-hashing-unverified'].message).toContain('the app was not introspected')
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
    expect(source.find((evaluation) => evaluation.check.key === 'deploy-password-hashing-unverified')?.check.evidence).toBe('none')
  })

  test('reports the verdicts unverified, and says why once, when the entry does not import', async () => {
    const dir = await cloudflareApp('broken-entry', {
      'src/app.ts': ARGON2_APP,
      'src/main.ts': "import app from './app.js'\nimport './missing-module.js'\n\nexport default app\n",
    })

    const checks = byKey((await runCheck({ cwd: dir, introspect: true })).checks)
    expect(checks['introspection-unavailable']).toMatchObject({ status: 'warn', advisory: true })
    expect(checks['introspection-unavailable'].message).toContain('(import)')
    expect(checks['deploy-password-hashing-unverified']).toMatchObject({ status: 'warn', evidence: 'none', advisory: true })
    expect(checks['deploy-password-hashing-unverified'].message).toContain('introspection failed with import')

    const skipped = byKey((await runCheck({ cwd: dir, introspect: false })).checks)
    expect(skipped['introspection-unavailable']).toBeUndefined()
  })

  test('cannot vouch for the hasher or the stores after a provider threw, and keeps it out of the gate', async () => {
    const dir = await cloudflareApp('threw', { 'src/app.ts': THROWING_APP })

    const report = await runCheck({ cwd: dir, introspect: true })
    const checks = byKey(report.checks)
    for (const key of ['deploy-password-hashing-unverified', 'deploy-runtime-stores-unverified']) {
      expect(checks[key]).toMatchObject({ status: 'warn', evidence: 'none', advisory: true })
      expect(checks[key].message).toContain('AuthProvider threw in register()')
    }
    expect(gatingResults(report).filter((result) => result.key.startsWith('deploy-'))).toEqual([])
  })

  test('never reads a session config left unbound for an unset env key as absent', async () => {
    const dir = await cloudflareApp('unset-env', { 'src/app.ts': UNSET_ENV_APP })

    const stores = byKey((await runCheck({ cwd: dir, introspect: true })).checks)['deploy-runtime-stores-unverified']
    expect(stores).toMatchObject({ status: 'warn', evidence: 'none' })
    expect(stores.message).toContain('whether the session store is per-process is unverified')
    expect(stores.message).toContain('RFC26_UNSET_SESSION_DRIVER, which the environment does not set')
    expect(stores.message).not.toContain('no session store configured')
  })

  test('introspects a Lambda target found only in source, after the scan', async () => {
    const dir = await cloudflareApp('lambda-source', {
      'package.json': JSON.stringify({ name: 'lambda-source', type: 'module' }),
      'src/app.ts': ARGON2_APP,
      'src/lambda.ts': "import { createLambdaHandler } from '@guren/core/lambda'\nimport app from './app.js'\n\nexport const handler = createLambdaHandler(app)\n",
    })

    const verdicts = await checkDeployRuntime(dir)
    expect(verdicts[0]).toMatchObject({ key: 'deploy-password-hashing', status: 'warn', evidence: 'manifest' })
    expect(verdicts[0].message).toStartWith('AWS Lambda detected')
  })

  test('wires --no-introspect through the guren check and doctor commands', async () => {
    const dir = await cloudflareApp('cli-flag', { 'src/app.ts': ARGON2_APP })
    const evidence = async (args: string[]): Promise<string | undefined> => {
      const run = await runCliBinCaptured([...args, '--json'], dir)
      const report = JSON.parse(firstJsonDocument(run.stdout)) as { checks: Array<{ key: string; evidence?: string }> }
      return report.checks.find((result) => result.key.startsWith('deploy-password-hashing'))?.evidence
    }

    expect(await evidence(['check'])).toBe('manifest')
    expect(await evidence(['check', '--no-introspect'])).toBe('none')
    expect(await evidence(['doctor', '--no-introspect'])).toBe('none')
  })

  test('does not introspect an app with no deploy target', async () => {
    const dir = await cloudflareApp('no-target', { 'package.json': JSON.stringify({ name: 'no-target', type: 'module' }) })

    const analysis = await readDeployRuntime(dir, {
      introspect: () => {
        throw new Error('introspected an app with no deploy target')
      },
    })
    expect(analysis.targets).toEqual([])
  })
})
