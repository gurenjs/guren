import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildJsonOutput, suggestNextSteps, type DoctorCheck, type DoctorReport } from '../src/doctor'
import { doctorRecheckArgs, repairDoctorReport } from '../src/doctor-fix'
import { commandFix } from '../src/check-result'
import type { CapturedExec } from '../src/subprocess'
import { createTempWorkspace, runCliBinCaptured, seedApiOnlyApp, writeWorkspaceFiles } from './helpers'

const repair = commandFix('codegen', '--force', '--routes', 'routes/api.ts')
function report(checks: DoctorCheck[]): DoctorReport {
  return { cwd: '/app', checks, fixableChecks: [], manualChecks: checks, hasWarnings: true, hasFailures: false, recommendedCommands: [] }
}
function finding(key = 'generated:routes', status: DoctorCheck['status'] = 'warn'): DoctorCheck {
  return { key, title: key, status, message: key, ...(status === 'pass' ? {} : { repair }) }
}
function output(after: DoctorReport) {
  return { exitCode: 0, stdout: JSON.stringify(buildJsonOutput(after)), stderr: '' }
}

describe('doctor generated-file repair', () => {
  test('deduplicates generator commands, leaves configuration autofixes alone and reports the fresh reading', async () => {
    const calls: string[][] = []
    const before = report([finding(), finding('generated:data'), { ...finding('tsconfig'), repair: undefined, canAutofix: true, fix: 'Edit tsconfig.json' }])
    const after = report([finding('generated:routes', 'pass'), finding('generated:data', 'pass'), before.checks[2]!])
    const exec: CapturedExec = async (args, cwd) => {
      expect(cwd).toBe('/app')
      calls.push(args)
      return args.includes('doctor') ? output(after) : { exitCode: 0, stdout: '', stderr: '' }
    }
    const result = await repairDoctorReport(before, { next: true, introspect: false }, exec)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.slice(2)).toEqual(repair.args)
    expect(calls[1]!.slice(2)).toEqual(['doctor', '--json', '--next', '--no-introspect'])
    expect(result.fixes).toEqual([{ command: 'bunx guren codegen --force --routes routes/api.ts', ok: true }])
    expect(result.checks[0]!.status).toBe('pass')
    expect(result.hasWarnings).toBe(true)
    expect(result.fixableChecks.map((check) => check.key)).toEqual(['tsconfig'])
  })

  test('an incomplete recheck cannot discard unrelated warnings', async () => {
    const before = report([finding(), { ...finding('tsconfig'), repair: undefined, canAutofix: true }])
    const after = report([finding('generated:routes', 'pass')])
    const result = await repairDoctorReport(before, {}, async (args) => args.includes('doctor') ? output(after) : { exitCode: 0, stdout: '', stderr: '' })
    expect(result.fixes?.[0]?.ok).toBe(false)
    expect(result.hasWarnings).toBe(true)
    expect(result.checks.map((check) => check.key)).toEqual(['generated:routes', 'tsconfig'])
  })

  test('preserves the introspection mode for recheck', () => {
    expect(doctorRecheckArgs({ introspect: true })).toEqual(['doctor', '--json'])
    expect(doctorRecheckArgs({})).toEqual(['doctor', '--json', '--no-introspect'])
  })

  test('does not run anything without a generated-file repair', async () => {
    const before = report([{ ...finding(), status: 'pass' }, { ...finding('scripts'), repair: undefined, canAutofix: true }])
    expect((await repairDoctorReport(before, {}, async () => { throw new Error('must not execute') })).fixes).toEqual([])
  })

  test('keeps generator failure output even when a later reading passes', async () => {
    const exec: CapturedExec = async (args) => args.includes('doctor')
      ? output(report([finding('generated:routes', 'pass')]))
      : { exitCode: 1, stdout: 'starting\n', stderr: 'routes failed\n' }
    const result = await repairDoctorReport(report([finding()]), {}, exec)
    expect(result.fixes?.[0]).toEqual({ command: 'bunx guren codegen --force --routes routes/api.ts', ok: false, output: ['starting', 'routes failed'] })
  })

  test.each(['still pending', 'repair metadata lost'])('a successful command fails verification when %s', async (scenario) => {
    const after = report([scenario === 'still pending' ? finding() : { ...finding(), repair: undefined }])
    const result = await repairDoctorReport(report([finding()]), {}, async (args) => args.includes('doctor') ? output(after) : { exitCode: 0, stdout: '', stderr: '' })
    expect(result.fixes?.[0]?.ok).toBe(false)
  })

  test.each(['invalid JSON', 'incomplete report', 'wrong version', 'wrong root', 'missing finding', 'child failure'])('cannot certify a repair with %s', async (scenario) => {
    const after = output(report([finding('generated:routes', 'pass')]))
    if (scenario === 'invalid JSON') after.stdout = 'not JSON'
    if (scenario === 'incomplete report') after.stdout = '{}'
    if (scenario === 'wrong version') after.stdout = after.stdout.replace('"version":1', '"version":2')
    if (scenario === 'wrong root') after.stdout = after.stdout.replace('"cwd":"/app"', '"cwd":"/other"')
    if (scenario === 'missing finding') after.stdout = output(report([])).stdout
    if (scenario === 'child failure') after.exitCode = 1
    const result = await repairDoctorReport(report([finding()]), {}, async (args) => args.includes('doctor') ? after : { exitCode: 0, stdout: '', stderr: '' })
    expect(result.fixes?.[0]?.ok).toBe(false)
    expect(result.fixes?.[0]?.output?.[0]).toContain('Could not verify')
    expect(result.checks[0]!.status).toBe('warn')
  })
})

describe('doctor --fix CLI', () => {
  test('repairs API-only artifacts once and preserves manual files and unrelated warnings', async () => {
    const workspace = await createTempWorkspace('guren-doctor-repair-api-')
    try {
      await seedApiOnlyApp(workspace.dir)
      const config = '{"include":["src"]}\n'
      const env = 'APP_KEY=\n'
      await writeWorkspaceFiles(workspace.dir, { 'tsconfig.json': config, '.env': env, '.guren/agents.gen.ts': 'stale agent manifest' })
      const steps = await suggestNextSteps({ cwd: workspace.dir })
      expect(steps.find((step) => step.title === 'Run codegen')?.command).toBe('bunx guren doctor --fix --next')
      const manifest = await readFile(join(workspace.dir, 'package.json'), 'utf8')
      const before = await runCliBinCaptured(['doctor', '--json', '--no-introspect'], workspace.dir)
      const initial = JSON.parse(before.stdout)
      expect(initial.fixes).toBeUndefined()
      expect(initial.checks.find((check: DoctorCheck) => check.key === 'generated:.guren/routes.gen.ts').repair.args).toEqual(repair.args)
      const run = await runCliBinCaptured(['doctor', '--fix', '--json', '--next', '--no-introspect'], workspace.dir)
      expect(run.exitCode).toBe(0)
      const after = JSON.parse(run.stdout)
      expect(after.fixes).toEqual([{ command: 'bunx guren codegen --force --routes routes/api.ts', ok: true }])
      for (const check of after.checks.filter((check: DoctorCheck) => check.key.startsWith('generated:'))) expect(check.status).toBe('pass')
      expect(after.nextSteps).toBeArray()
      expect(await readFile(join(workspace.dir, 'package.json'), 'utf8')).toBe(manifest)
      expect(await readFile(join(workspace.dir, 'tsconfig.json'), 'utf8')).toBe(config)
      expect(await readFile(join(workspace.dir, '.env'), 'utf8')).toBe(env)
      expect(after.summary.warn + after.summary.fail).toBeGreaterThan(0)
      const repeated = await runCliBinCaptured(['doctor', '--fix', '--json', '--no-introspect'], workspace.dir)
      expect(repeated.exitCode).toBe(0)
      expect(JSON.parse(repeated.stdout).fixes).toEqual([])
      const strict = await runCliBinCaptured(['doctor', '--fix', '--strict', '--json', '--no-introspect'], workspace.dir)
      expect(strict.exitCode).toBe(1)
      expect(JSON.parse(strict.stdout).fixes).toEqual([])
    } finally { await workspace.cleanup() }
  }, 30_000)

  test('rechecks a routes import that generation made resolvable in a fresh process', async () => {
    const workspace = await createTempWorkspace('guren-doctor-repair-import-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'package.json': '{}',
        'resources/js/pages/Home.tsx': 'export default function Home() { return <div /> }',
        'routes/web.ts': `import { pages } from '../.guren/pages.gen'
export function registerWebRoutes(router) {
  router.get('/', () => pages.Home).name('home').agent({})
}`,
      })
      const run = await runCliBinCaptured(['doctor', '--fix', '--json', '--no-introspect'], workspace.dir)
      expect(run.exitCode).toBe(0)
      const after = JSON.parse(run.stdout)
      expect(after.fixes).toEqual([{ command: 'bunx guren codegen --force --routes routes/web.ts', ok: true }])
      for (const key of ['page-contracts', 'generated:.guren/pages.gen.ts', 'generated:.guren/agents.gen.ts']) {
        expect(after.checks.find((check: DoctorCheck) => check.key === key).status).toBe('pass')
      }
    } finally { await workspace.cleanup() }
  }, 30_000)

  test('reports a failed generator and exits nonzero', async () => {
    const workspace = await createTempWorkspace('guren-doctor-repair-fail-')
    try {
      await seedApiOnlyApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { 'routes/api.ts': "throw new Error('broken routes')" })
      const run = await runCliBinCaptured(['doctor', '--fix', '--json', '--no-introspect'], workspace.dir)
      expect(run.exitCode).toBe(1)
      const after = JSON.parse(run.stdout)
      expect(after.fixes).toHaveLength(1)
      expect(after.fixes[0].ok).toBe(false)
      expect(after.fixes[0].output.join('\n')).toContain('broken routes')
    } finally { await workspace.cleanup() }
  }, 30_000)
})
