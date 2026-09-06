import { mkdir, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { describeGateFailures, GATE_STAGES, runGate, type GateExec, type GateExecResult, type GateReport } from '../src/gate'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'

const repoRoot = resolve(import.meta.dir, '../../..')

// A fixture `check` and `audit` pass on (measured): a registrar, its controller, and
// the two manifests `check` expects on disk. Subprocess stages go through a fake exec.
const PASSING_APP: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'gate-fixture',
    scripts: { codegen: 'guren codegen', typecheck: 'tsc --noEmit', test: 'bun test' },
  }),
  'routes/web.ts': `class HomeController {
  async index() { return null }
}
export default function registerRoutes(router: any) {
  router.get('/', [HomeController, 'index'])
}
`,
  'app/Http/Controllers/HomeController.ts': `export class HomeController {
  async index() { return this.json({ ok: true }) }
}
`,
  '.guren/routes.gen.ts': 'export {}\n',
  '.guren/data.gen.ts': 'export {}\n',
}

const OK: GateExecResult = { exitCode: 0, stdout: '', stderr: '' }

/** Records every command; answers from `responses` by the command's second word (`run codegen` → `codegen`, `test`). */
function fakeExec(responses: Partial<Record<string, GateExecResult>> = {}): { exec: GateExec; calls: string[][] } {
  const calls: string[][] = []
  const exec: GateExec = async (command) => {
    calls.push(command)
    const key = command[1] === 'run' ? command[2]! : command[1]!
    return responses[key] ?? OK
  }
  return { exec, calls }
}

function stage(report: GateReport, name: (typeof GATE_STAGES)[number]) {
  const found = report.stages.find((s) => s.name === name)
  if (!found) throw new Error(`no ${name} stage in report`)
  return found
}

describe('runGate', () => {
  it('runs every stage in CI order and passes a clean app', async () => {
    const workspace = await createTempWorkspace('guren-cli-gate-pass-')
    try {
      await writeWorkspaceFiles(workspace.dir, PASSING_APP)
      const { exec, calls } = fakeExec()

      const report = await runGate({ cwd: workspace.dir, exec })

      expect(report.ok).toBe(true)
      expect(report.stages.map((s) => s.name)).toEqual([...GATE_STAGES])
      expect(stage(report, 'check').status).toBe('pass')
      expect(stage(report, 'audit').status).toBe('pass')
      // No .oxlintrc.json is the app's opt-out, the one skip a gate allows.
      expect(stage(report, 'lint')).toMatchObject({ status: 'skip', reason: expect.stringContaining('.oxlintrc.json') })
      // The app's own scripts, in the order CI runs them; codegen before typecheck.
      expect(calls.map((c) => c.slice(1).join(' '))).toEqual(['run codegen', 'run typecheck', 'run test'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails on one failing stage, keeps running the rest, and reports what to fix', async () => {
    const workspace = await createTempWorkspace('guren-cli-gate-typecheck-')
    try {
      await writeWorkspaceFiles(workspace.dir, PASSING_APP)
      const { exec, calls } = fakeExec({
        typecheck: {
          exitCode: 2,
          stdout: "app/Http/Controllers/HomeController.ts(2,20): error TS2339: Property 'json' does not exist.\n",
          stderr: '',
        },
      })

      const report = await runGate({ cwd: workspace.dir, exec })

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
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports test failures by their (fail) lines and the summary', async () => {
    const workspace = await createTempWorkspace('guren-cli-gate-test-')
    try {
      await writeWorkspaceFiles(workspace.dir, PASSING_APP)
      const { exec } = fakeExec({
        test: {
          exitCode: 1,
          stdout: '',
          stderr: 'tests/HomeController.test.ts:\n(pass) index > lists\n(fail) index > shows [3ms]\n\n 1 pass\n 1 fail\nRan 2 tests\n',
        },
      })

      const report = await runGate({ cwd: workspace.dir, exec })

      expect(stage(report, 'test').findings).toEqual(['(fail) index > shows [3ms]', ' 1 fail'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('treats a stage it cannot run as a failure, not a skip', async () => {
    const workspace = await createTempWorkspace('guren-cli-gate-unrunnable-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        ...PASSING_APP,
        'package.json': JSON.stringify({ name: 'gate-fixture', scripts: { codegen: 'x', test: 'x' } }),
        '.oxlintrc.json': '{}',
      })
      const { exec, calls } = fakeExec()

      const report = await runGate({ cwd: workspace.dir, exec })

      expect(report.ok).toBe(false)
      expect(stage(report, 'typecheck')).toMatchObject({ status: 'fail', reason: expect.stringContaining('"typecheck" script') })
      expect(calls.some((c) => c.includes('typecheck'))).toBe(false)
      // .oxlintrc.json opts in, and no oxlint is reachable from a temp dir.
      expect(stage(report, 'lint')).toMatchObject({ status: 'fail', reason: expect.stringContaining('oxlint is not installed') })
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails when the routes entry cannot be loaded rather than passing a vacuous audit', async () => {
    const workspace = await createTempWorkspace('guren-cli-gate-no-routes-')
    try {
      const { 'routes/web.ts': _routes, ...withoutRoutes } = PASSING_APP
      await writeWorkspaceFiles(workspace.dir, withoutRoutes)

      const report = await runGate({ cwd: workspace.dir, exec: fakeExec().exec })

      expect(stage(report, 'audit')).toMatchObject({ status: 'fail', reason: expect.stringContaining('--routes') })
    } finally {
      await workspace.cleanup()
    }
  })

  it('lints through the oxlint shim, reporting warnings on a passing stage', async () => {
    const workspace = await createTempWorkspace('guren-cli-gate-lint-')
    try {
      await writeWorkspaceFiles(workspace.dir, { ...PASSING_APP, '.oxlintrc.json': '{}' })
      await mkdir(join(workspace.dir, 'node_modules'), { recursive: true })
      await symlink(join(repoRoot, 'node_modules', 'oxlint'), join(workspace.dir, 'node_modules', 'oxlint'), 'dir')
      const calls: string[][] = []
      const exec: GateExec = async (command) => {
        calls.push(command)
        if (command[1]?.endsWith('/oxlint')) {
          return { exitCode: 0, stdout: 'lib.ts:1:1: Unexpected debugger statement. [Warning/eslint(no-debugger)]\nFound 1 warning.\n', stderr: '' }
        }
        return OK
      }

      const report = await runGate({ cwd: workspace.dir, exec })

      const lint = calls.find((c) => c[1]?.endsWith('/oxlint'))
      expect(lint?.slice(2)).toEqual(['--no-error-on-unmatched-pattern', '--format', 'unix'])
      expect(stage(report, 'lint')).toMatchObject({ status: 'pass', findings: ['lib.ts:1:1: Unexpected debugger statement. [Warning/eslint(no-debugger)]'] })
      expect(report.ok).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('an oxlint that exits without linting is a failure, not a clean run', async () => {
    const workspace = await createTempWorkspace('guren-cli-gate-lint-broken-')
    try {
      await writeWorkspaceFiles(workspace.dir, { ...PASSING_APP, '.oxlintrc.json': '{}' })
      await mkdir(join(workspace.dir, 'node_modules'), { recursive: true })
      await symlink(join(repoRoot, 'node_modules', 'oxlint'), join(workspace.dir, 'node_modules', 'oxlint'), 'dir')
      const exec: GateExec = async (command) =>
        command[1]?.endsWith('/oxlint') ? { exitCode: 1, stdout: '', stderr: 'Failed to load plugin ./missing.js\n' } : OK

      const report = await runGate({ cwd: workspace.dir, exec })

      expect(stage(report, 'lint')).toMatchObject({
        status: 'fail',
        reason: 'oxlint exited 1 without linting',
        findings: ['Failed to load plugin ./missing.js'],
      })
    } finally {
      await workspace.cleanup()
    }
  })

  it('--changed narrows lint to changed lintable files and skips when there are none', async () => {
    const workspace = await createTempWorkspace('guren-cli-gate-changed-')
    try {
      await writeWorkspaceFiles(workspace.dir, { ...PASSING_APP, '.oxlintrc.json': '{}', 'lib.ts': 'export const a = 1\n', '.guren/x.ts': 'debugger\n', 'README.md': 'x' })
      await mkdir(join(workspace.dir, 'node_modules'), { recursive: true })
      await symlink(join(repoRoot, 'node_modules', 'oxlint'), join(workspace.dir, 'node_modules', 'oxlint'), 'dir')
      // Untracked files in a fresh repository are the changed set.
      Bun.spawnSync(['git', 'init', '-q'], { cwd: workspace.dir })
      const { exec, calls } = fakeExec()

      const report = await runGate({ cwd: workspace.dir, changed: true, exec })

      expect(report.changed).toBe(true)
      const lint = calls.find((c) => c[1]?.endsWith('/oxlint'))
      const files = lint?.slice(lint.indexOf('unix') + 1)
      expect(files).toContain('lib.ts')
      expect(files).toContain('routes/web.ts')
      expect(files).not.toContain('.guren/x.ts')
      expect(files).not.toContain('README.md')
      expect(stage(report, 'lint').status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('outside a git repository --changed runs the gate in full', async () => {
    const workspace = await createTempWorkspace('guren-cli-gate-nogit-')
    try {
      await writeWorkspaceFiles(workspace.dir, PASSING_APP)

      const report = await runGate({ cwd: workspace.dir, changed: true, exec: fakeExec().exec })

      expect(report.changed).toBe(false)
      expect(report.ok).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('a subprocess that cannot even start fails its stage with the error', async () => {
    const workspace = await createTempWorkspace('guren-cli-gate-spawn-error-')
    try {
      await writeWorkspaceFiles(workspace.dir, PASSING_APP)
      const exec: GateExec = async (command) => {
        if (command.includes('codegen')) throw new Error('spawn bun ENOENT')
        return OK
      }

      const report = await runGate({ cwd: workspace.dir, exec })

      expect(stage(report, 'codegen')).toMatchObject({ status: 'fail', reason: 'could not run: spawn bun ENOENT' })
      expect(stage(report, 'test').status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })
})
