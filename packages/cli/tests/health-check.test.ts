import { describe, expect, it, mock } from 'bun:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createTempWorkspace,
  createConsolaStub,
  runCliBinCaptured,
  writeWorkspaceFiles,
} from './helpers'

interface HealthReportJson {
  status: string
  checks: Array<{ name: string; message?: string }>
}

interface HealthCliRun {
  stderr: string
  exitCode: number
  /** Parsed stdout — the helper always passes `--json`. */
  report: HealthReportJson
}

/**
 * Run `health:check --json` and return its parsed report. A subprocess because
 * the paths under test end in `process.exit(1)` and the exit code is half of
 * what they assert; {@link runCliBinCaptured} owns the child's environment.
 */
async function runHealthCli(cwd: string, args: string[] = []): Promise<HealthCliRun> {
  const { stdout, stderr, exitCode } = await runCliBinCaptured(
    ['health:check', ...args, '--json'],
    cwd,
  )
  return { stderr, exitCode, report: JSON.parse(stdout) as HealthReportJson }
}

/**
 * A health file exporting `exportName`. One builder rather than a literal per
 * test: a copy missing a member the loader recognizes fails as "exports no
 * health manager", pointing at the loader rather than at the stale fixture.
 */
function managerSource(
  exportName: string,
  options: { checkName?: string; omitChecks?: boolean } = {},
): string {
  const { checkName = 'ok', omitChecks = false } = options
  const reported = omitChecks ? '' : `, checks: [{ name: '${checkName}', status: 'healthy' }]`
  const empty = omitChecks ? '' : ', checks: []'

  return `export const ${exportName} = {
  async check() {
    return { status: 'healthy', timestamp: new Date()${reported} }
  },
  async checkOnly() {
    return { status: 'healthy', timestamp: new Date()${empty} }
  },
  getCheckNames() {
    return ['${checkName}']
  },
}
`
}

const consolaStub = createConsolaStub({ debug: mock(() => {}) })

await mock.module('consola', () => ({
  consola: consolaStub,
  default: consolaStub,
  createConsola: () => consolaStub,
  LogLevels: {},
}))

const { runHealthCheck } = await import('../src/health-check')

describe('runHealthCheck', () => {
  it('prints a basic report when no health manager is configured', async () => {
    const workspace = await createTempWorkspace('guren-cli-health-basic-')
    const logSpy = mock(() => {})
    const originalLog = console.log
    console.log = logSpy as typeof console.log

    try {
      await runHealthCheck({ appRoot: workspace.dir, json: true })
      expect(logSpy).toHaveBeenCalled()
    } finally {
      console.log = originalLog
      await workspace.cleanup()
    }
  })

  it('says the health file could not be read, rather than reporting none', async () => {
    // Spawned: this path exits non-zero, half of what is under test. A health
    // file that throws on import must not read as "No health manager found"
    // with `--json` answering healthy off the built-in checks alone.
    const workspace = await createTempWorkspace('guren-cli-health-unreadable-')

    try {
      await mkdir(join(workspace.dir, 'app'), { recursive: true })
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/health.ts'),
        "import 'a-package-that-is-not-installed'\nexport const health = {}\n",
        'utf8',
      )
      // Two candidate paths, one file. A case-insensitive filesystem does this
      // on its own, but only a symlink reproduces it on ext4 — without one the
      // dedupe could be deleted with this assertion still passing.
      await symlink(join(workspace.dir, 'app/health.ts'), join(workspace.dir, 'src/health.ts'))

      const { stderr, exitCode, report } = await runHealthCli(workspace.dir)

      expect(exitCode).toBe(1)
      expect(stderr).toContain('Health checks could not be read')
      expect(stderr).not.toContain('No health manager found')

      expect(report.status).toBe('unhealthy')

      // One finding, not one per candidate path — see `fileIdentity`.
      const configChecks = report.checks.filter((check) => check.name === 'health-config')
      expect(configChecks).toHaveLength(1)
      expect(configChecks[0]?.message).toContain('app/health.ts')
      expect(configChecks[0]?.message).toContain('a-package-that-is-not-installed')
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports an explicit --health file that exports no manager', async () => {
    // `--health <path>` names the file, so anything that stops it yielding a
    // manager is a failure, a cleanly imported wrong shape included. The
    // default candidate list is a *search*, so a miss there stays silent.
    const workspace = await createTempWorkspace('guren-cli-health-wrong-shape-')

    try {
      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(join(workspace.dir, 'config/health.ts'), 'export const health = {}\n', 'utf8')

      const { exitCode, report } = await runHealthCli(workspace.dir, ['--health', 'config/health.ts'])

      expect(exitCode).toBe(1)
      expect(report.status).toBe('unhealthy')
      expect(report.checks.find((check) => check.name === 'health-config')?.message)
        .toContain('exports no health manager')
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports a health file that exists only as a dangling symlink', async () => {
    // `existsSync` answers "no" for a dangling symlink, an untraversable
    // parent, and an `app` that is a regular file. Skipping the candidate on
    // any of those leaves `loadErrors` empty and reports a healthy app.
    const workspace = await createTempWorkspace('guren-cli-health-dangling-')

    try {
      await mkdir(join(workspace.dir, 'app'), { recursive: true })
      await symlink(join(workspace.dir, 'app/nowhere.ts'), join(workspace.dir, 'app/health.ts'))

      const { exitCode, report } = await runHealthCli(workspace.dir)

      expect(exitCode).toBe(1)
      expect(report.status).toBe('unhealthy')
      // `realpath` cannot answer for a dangling link: the case
      // `fileIdentity`'s inode fallback exists for.
      expect(report.checks.filter((check) => check.name === 'health-config')).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('finds a manager that a placeholder export would have shadowed', async () => {
    // The export is picked by truthiness before its shape is tested, so a
    // placeholder `health` must not shadow a real `healthManager`.
    const workspace = await createTempWorkspace('guren-cli-health-shadowed-')

    try {
      await writeWorkspaceFiles(workspace.dir, {
        'app/health.ts': `export const health = {}\n${managerSource('healthManager', { checkName: 'real' })}`,
      })

      const { exitCode, report } = await runHealthCli(workspace.dir)

      expect(exitCode).toBe(0)
      // The configured check ran; the built-in fallbacks did not.
      expect(report.checks.map((check) => check.name)).toEqual(['real'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('treats --health with an empty value as no flag at all', async () => {
    // The mode switch and the path list read `options.health` differently
    // (`!== undefined` versus truthiness), so citty's `''` for a valued flag
    // with no value can turn on named-file strictness over the default search.
    const workspace = await createTempWorkspace('guren-cli-health-empty-flag-')

    try {
      await mkdir(join(workspace.dir, 'app'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/health.ts'), 'export const health = {}\n', 'utf8')

      const run = async (args: string[]) => {
        const { exitCode, report } = await runHealthCli(workspace.dir, args)
        // Timestamps and uptime differ between two runs by construction, so
        // the comparison is over what the flag could actually change.
        return { exitCode, status: report.status, checks: report.checks.map((c) => c.name) }
      }

      // Asserted against the no-flag run rather than a literal: an empty value
      // names no file. Concurrent because both only read the fixture.
      const [withEmptyFlag, withoutFlag] = await Promise.all([run(['--health=']), run([])])
      expect(withEmptyFlag).toEqual(withoutFlag)
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps an earlier load failure in the report when a later file works', async () => {
    // A broken `app/health.ts` beside a working `src/health.ts` must still
    // fail: the file the operator configured never ran.
    const workspace = await createTempWorkspace('guren-cli-health-partial-')

    try {
      await writeWorkspaceFiles(workspace.dir, {
        'app/health.ts': "import 'a-package-that-is-not-installed'\nexport const health = {}\n",
        'src/health.ts': managerSource('health', { checkName: 'src-one' }),
      })

      const { exitCode, report } = await runHealthCli(workspace.dir)

      expect(exitCode).toBe(1)
      expect(report.status).toBe('unhealthy')
      // The working manager's checks still run and are still reported.
      expect(report.checks.map((check) => check.name)).toEqual(['health-config', 'src-one'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('survives a manager whose report omits checks', async () => {
    // The manager is app-authored and arrives through `import()`, so nothing
    // type-checks its report: splicing load failures into one with no `checks`
    // spreads `undefined`, on the very path that has a diagnostic to print.
    const workspace = await createTempWorkspace('guren-cli-health-checkless-')

    try {
      await writeWorkspaceFiles(workspace.dir, {
        'app/health.ts': "import 'a-package-that-is-not-installed'\n",
        'src/health.ts': managerSource('health', { omitChecks: true }),
      })

      const { exitCode, report } = await runHealthCli(workspace.dir)

      expect(exitCode).toBe(1)
      expect(report.status).toBe('unhealthy')
      expect(report.checks.map((check) => check.name)).toEqual(['health-config'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('uses configured health checks when available', async () => {
    const workspace = await createTempWorkspace('guren-cli-health-config-')
    const logSpy = mock(() => {})
    const originalLog = console.log
    console.log = logSpy as typeof console.log

    try {
      await mkdir(join(workspace.dir, 'app'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/health.ts'),
        `
export const health = {
  async check() {
    return { status: 'healthy', timestamp: new Date(), checks: [] }
  },
  async checkOnly(names) {
    globalThis.__healthChecks = names
    return { status: 'healthy', timestamp: new Date(), checks: [] }
  },
  getCheckNames() {
    return ['db', 'cache']
  },
}
`,
        'utf8',
      )

      await runHealthCheck({ appRoot: workspace.dir, checks: 'db,cache', json: true })

      expect((globalThis as typeof globalThis & { __healthChecks?: string[] }).__healthChecks).toEqual(['db', 'cache'])
    } finally {
      delete (globalThis as typeof globalThis & { __healthChecks?: string[] }).__healthChecks
      console.log = originalLog
      await workspace.cleanup()
    }
  })
})
