import { describe, expect, it, spyOn } from 'bun:test'
import { consola } from 'consola'
import { describeGateFailures, GATE_STAGES, renderGateReport, runGate, type GateExec, type GateExecResult, type GateReport } from '../src/gate'
import type { Introspection } from '../src/introspect'
import { createTempWorkspace, gateAppFiles, initGitRepo, linkOxlint, manifestFixture, PG_SCHEMA_FIXTURE, sessionConfigSource, writeWorkspaceFiles } from './helpers'

const SCRIPTS = { codegen: 'guren codegen', typecheck: 'tsc --noEmit', test: 'bun test' }

const OK: GateExecResult = { exitCode: 0, stdout: '', stderr: '' }

/** Records every command; answers from `responses` by the command's second word (`run codegen` -> `codegen`, `test`). */
function fakeExec(responses: Partial<Record<string, GateExecResult>> = {}): { exec: GateExec; calls: string[][] } {
  const calls: string[][] = []
  const exec: GateExec = async (command) => {
    calls.push(command)
    const key = command[1] === 'run' ? command[2]! : command[1]!
    return responses[key] ?? OK
  }
  return { exec, calls }
}

function isOxlint(command: string[]): boolean {
  return command[1]?.endsWith('/oxlint') ?? false
}

function stage(report: GateReport, name: (typeof GATE_STAGES)[number]) {
  const found = report.stages.find((s) => s.name === name)
  if (!found) throw new Error(`no ${name} stage in report`)
  return found
}

async function withApp(
  prefix: string,
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
  options: { oxlint?: boolean } = {},
): Promise<void> {
  const workspace = await createTempWorkspace(`guren-cli-gate-${prefix}-`)
  try {
    await writeWorkspaceFiles(workspace.dir, files)
    if (options.oxlint) await linkOxlint(workspace.dir)
    await fn(workspace.dir)
  } finally {
    await workspace.cleanup()
  }
}

describe('runGate', () => {
  it('runs every stage in CI order and passes a clean app', async () => {
    await withApp('pass', gateAppFiles(SCRIPTS), async (dir) => {
      const { exec, calls } = fakeExec()

      const report = await runGate({ cwd: dir, exec })

      expect(report.ok).toBe(true)
      expect(report.stages.map((s) => s.name)).toEqual([...GATE_STAGES])
      expect(stage(report, 'check').status).toBe('pass')
      expect(stage(report, 'audit').status).toBe('pass')
      // No .oxlintrc.json is the app's opt-out, the one skip a gate allows.
      expect(stage(report, 'lint')).toMatchObject({ status: 'skip', reason: expect.stringContaining('.oxlintrc.json') })
      // The app's own scripts, in the order CI runs them; codegen before typecheck.
      expect(calls.map((c) => c.slice(1).join(' '))).toEqual(['run codegen', 'run typecheck', 'run test'])
    })
  })

  it('fails on one failing stage, keeps running the rest, and reports what to fix', async () => {
    await withApp('typecheck', gateAppFiles(SCRIPTS), async (dir) => {
      const { exec, calls } = fakeExec({
        typecheck: {
          exitCode: 2,
          stdout: "app/Http/Controllers/HomeController.ts(2,20): error TS2339: Property 'json' does not exist.\n",
          stderr: '',
        },
      })

      const report = await runGate({ cwd: dir, exec })

      expect(report.ok).toBe(false)
      const typecheck = stage(report, 'typecheck')
      expect(typecheck.status).toBe('fail')
      expect(typecheck.reason).toBe('`bun run typecheck` exited 2')
      expect(typecheck.findings).toHaveLength(1)
      expect(typecheck.findings[0]).toContain('error TS2339')
      expect(stage(report, 'test').status).toBe('pass')
      expect(calls.some((c) => c.includes('test'))).toBe(true)
      const text = describeGateFailures(report)
      expect(text).toContain('guren gate: typecheck failed')
      expect(text).toContain('- app/Http/Controllers/HomeController.ts(2,20)')
      expect(text).not.toContain('codegen')
    })
  })

  it('reports test failures by their (fail) lines and the summary', async () => {
    await withApp('test', gateAppFiles(SCRIPTS), async (dir) => {
      const { exec } = fakeExec({
        test: {
          exitCode: 1,
          stdout: '',
          stderr: 'tests/HomeController.test.ts:\n(pass) index > lists\n(fail) index > shows [3ms]\n\n 1 pass\n 1 fail\nRan 2 tests\n',
        },
      })

      const report = await runGate({ cwd: dir, exec })

      expect(stage(report, 'test').findings).toEqual(['(fail) index > shows [3ms]', ' 1 fail'])
    })
  })

  it('treats a stage it cannot run as a failure, not a skip', async () => {
    const files = { ...gateAppFiles({ codegen: 'x', test: 'x' }), '.oxlintrc.json': '{}' }
    await withApp('unrunnable', files, async (dir) => {
      const { exec, calls } = fakeExec()

      const report = await runGate({ cwd: dir, exec })

      expect(report.ok).toBe(false)
      expect(stage(report, 'typecheck')).toMatchObject({ status: 'fail', reason: expect.stringContaining('"typecheck" script') })
      expect(calls.some((c) => c.includes('typecheck'))).toBe(false)
      // .oxlintrc.json opts in, and no oxlint is reachable from a temp dir.
      expect(stage(report, 'lint')).toMatchObject({ status: 'fail', reason: expect.stringContaining('oxlint is not installed') })
    })
  })

  it('fails when the routes entry cannot be loaded rather than passing a vacuous audit', async () => {
    const { 'routes/web.ts': _routes, ...withoutRoutes } = gateAppFiles(SCRIPTS)
    await withApp('no-routes', withoutRoutes, async (dir) => {
      const report = await runGate({ cwd: dir, exec: fakeExec().exec })

      expect(stage(report, 'audit')).toMatchObject({ status: 'fail', reason: expect.stringContaining('--routes') })
    })
  })

  it('audits an API-only app through its routes/api.ts entry without --routes', async () => {
    const { 'routes/web.ts': routes, ...rest } = gateAppFiles(SCRIPTS)
    await withApp('api-entry', { ...rest, 'routes/api.ts': routes! }, async (dir) => {
      const report = await runGate({ cwd: dir, exec: fakeExec().exec })

      expect(stage(report, 'audit').status).toBe('pass')
    })
  })

  it('lints through the oxlint shim, reporting warnings on a passing stage', async () => {
    await withApp('lint', { ...gateAppFiles(SCRIPTS), '.oxlintrc.json': '{}' }, async (dir) => {
      const calls: string[][] = []
      const exec: GateExec = async (command) => {
        calls.push(command)
        if (isOxlint(command)) {
          return { exitCode: 0, stdout: 'lib.ts:1:1: Unexpected debugger statement. [Warning/eslint(no-debugger)]\nFound 1 warning.\n', stderr: '' }
        }
        return OK
      }

      const report = await runGate({ cwd: dir, exec })

      const lint = calls.find(isOxlint)
      expect(lint?.slice(2)).toEqual(['--no-error-on-unmatched-pattern', '--format', 'unix'])
      expect(stage(report, 'lint')).toMatchObject({ status: 'pass', findings: ['lib.ts:1:1: Unexpected debugger statement. [Warning/eslint(no-debugger)]'] })
      expect(report.ok).toBe(true)
    }, { oxlint: true })
  })

  it('an oxlint that exits without linting is a failure, not a clean run', async () => {
    await withApp('lint-broken', { ...gateAppFiles(SCRIPTS), '.oxlintrc.json': '{}' }, async (dir) => {
      const exec: GateExec = async (command) =>
        isOxlint(command) ? { exitCode: 1, stdout: '', stderr: 'Failed to load plugin ./missing.js\n' } : OK

      const report = await runGate({ cwd: dir, exec })

      expect(stage(report, 'lint')).toMatchObject({
        status: 'fail',
        reason: 'oxlint exited 1 without linting',
        findings: ['Failed to load plugin ./missing.js'],
      })
    }, { oxlint: true })
  })

  it('--changed narrows lint to changed lintable files and skips when there are none', async () => {
    const files = { ...gateAppFiles(SCRIPTS), '.oxlintrc.json': '{}', 'lib.ts': 'export const a = 1\n', '.guren/x.ts': 'debugger\n', 'README.md': 'x' }
    await withApp('changed', files, async (dir) => {
      initGitRepo(dir)
      const { exec, calls } = fakeExec()

      const report = await runGate({ cwd: dir, changed: true, exec })

      expect(report.changed).toBe(true)
      const lint = calls.find(isOxlint)
      const linted = lint?.slice(lint.indexOf('unix') + 1)
      expect(linted).toContain('lib.ts')
      expect(linted).toContain('routes/web.ts')
      expect(linted).not.toContain('.guren/x.ts')
      expect(linted).not.toContain('README.md')
      expect(stage(report, 'lint').status).toBe('pass')
    }, { oxlint: true })
  })

  it('names a stage detail, such as the dependency scan, in the rendered line', async () => {
    await withApp('deps', gateAppFiles(SCRIPTS), async (dir) => {
      const lines: string[] = []
      const spies = (['success', 'error', 'info', 'box'] as const).map((level) =>
        spyOn(consola, level).mockImplementation(((message: unknown) => {
          lines.push(String(message))
        }) as never),
      )
      try {
        const plain = await runGate({ cwd: dir, exec: fakeExec().exec })
        renderGateReport(plain)
        expect(stage(plain, 'audit').detail).toBeUndefined()
        expect(lines.some((line) => line.includes('dependency scan'))).toBe(false)

        // Stubbed so the test stays off the registry; only the label is under test.
        const stages = plain.stages.map((s) => (s.name === 'audit' ? { ...s, detail: 'dependency scan' } : s))
        renderGateReport({ ...plain, stages })
        expect(lines.some((line) => line.includes('audit + dependency scan'))).toBe(true)
      } finally {
        for (const spy of spies) spy.mockRestore()
      }
    })
  })

  it('outside a git repository --changed runs the gate in full', async () => {
    await withApp('nogit', gateAppFiles(SCRIPTS), async (dir) => {
      const report = await runGate({ cwd: dir, changed: true, exec: fakeExec().exec })

      expect(report.changed).toBe(false)
      expect(report.ok).toBe(true)
    })
  })

  describe('reading the introspected app (RFC 0026 §5)', () => {
    /** A routes file audit judges (a POST) and a session config check judges: both stages ask. */
    const files = {
      ...gateAppFiles(SCRIPTS),
      'routes/web.ts': `class PostController {
  async store() { return null }
}
export default function registerRoutes(router: any) {
  router.post('/posts', [PostController, 'store'])
}
`,
      'config/session.ts': sessionConfigSource("database: { driver: 'database', table: sessions }"),
      'db/schema.ts': `${PG_SCHEMA_FIXTURE}\nexport const sessions = pgTable('sessions', { id: text('id').primaryKey() })\n`,
    }

    function counted(result: Introspection): { introspect: () => Promise<Introspection>; calls: () => number } {
      let calls = 0
      return { introspect: async () => (calls++, result), calls: () => calls }
    }

    it('runs one introspection for the check and audit stages, and judges from it', async () => {
      await withApp('introspect', files, async (dir) => {
        // A manager beside auth.sessionOptions.store only the registered app shows, and it refuses to boot.
        const manifest = manifestFixture({
          session: { source: 'manager', default: 'database', stores: { database: { driver: 'database', table: 'sessions', perProcess: false } } },
          warnings: [{ code: 'session-configured-twice', message: 'both configure sessions' }],
        })
        const run = counted({ status: 'ok', manifest })

        const report = await runGate({ cwd: dir, exec: fakeExec().exec, introspect: run.introspect })

        expect(run.calls()).toBe(1)
        expect(stage(report, 'check')).toMatchObject({ status: 'fail', findings: [expect.stringContaining('refuses to boot')] })
        expect(stage(report, 'audit').status).toBe('pass')
      })
    })

    it('names a failed introspection on the audit stage when only the audit asked', async () => {
      const { 'config/session.ts': _session, ...auditOnly } = files
      await withApp('introspect-audit-only', auditOnly, async (dir) => {
        const run = counted({ status: 'failed', reason: 'crashed', message: 'The introspection process exited with code 1.' })

        const report = await runGate({ cwd: dir, exec: fakeExec().exec, introspect: run.introspect })

        expect(run.calls()).toBe(1)
        expect(stage(report, 'check').findings).toEqual([])
        expect(stage(report, 'audit')).toMatchObject({
          status: 'pass',
          findings: [expect.stringMatching(/^Introspection \(advisory\): The app could not be introspected \(crashed\)/)],
        })
      })
    })

    it('names a failed introspection once, on the stage that met it, without failing it', async () => {
      await withApp('introspect-failed', files, async (dir) => {
        const run = counted({ status: 'failed', reason: 'import', message: 'Could not load src/main.ts.' })

        const report = await runGate({ cwd: dir, exec: fakeExec().exec, introspect: run.introspect })

        expect(run.calls()).toBe(1)
        const check = stage(report, 'check')
        expect(check.status).toBe('pass')
        expect(check.findings).toEqual([expect.stringMatching(/^Introspection \(advisory\): The app could not be introspected \(import\)/)])
        expect(stage(report, 'audit').findings.some((finding) => finding.includes('introspected'))).toBe(false)
        expect(report.ok).toBe(true)
      })
    })
  })

  it('a subprocess that cannot even start fails its stage with the error', async () => {
    await withApp('spawn-error', gateAppFiles(SCRIPTS), async (dir) => {
      const exec: GateExec = async (command) => {
        if (command.includes('codegen')) throw new Error('spawn bun ENOENT')
        return OK
      }

      const report = await runGate({ cwd: dir, exec })

      expect(stage(report, 'codegen')).toMatchObject({ status: 'fail', reason: 'could not run: spawn bun ENOENT' })
      expect(stage(report, 'test').status).toBe('pass')
    })
  })
})
